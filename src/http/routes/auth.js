import { HttpError, actorOf } from '../router.js';
import { sessionCookie, clearCookie, LoginLimiter } from '../auth.js';
import { hashPassword, verifyPassword } from '../../crypto.js';
import * as sessions from '../../store/repos/sessions.js';
import * as users from '../../store/repos/users.js';
import * as events from '../../store/repos/events.js';

// Checked when the user name is unknown or disabled, so the answer takes as
// long as for a real account. Made once, at the first such login.
let dummyHash = null;
async function dummy() {
    dummyHash ??= await hashPassword('not a password of anyone');
    return dummyHash;
}

/** The answer for /api/auth/me and a login. */
function me(session) {
    return { user: session.username, csrfToken: session.csrfToken, mustChangePassword: !!session.mustChangePassword };
}

export function authRoutes(router, { cfg }) {
    const limiter = new LoginLimiter();

    // Login has no session yet, so it cannot carry a CSRF token; the origin
    // check in the server still applies.
    router.post(
        '/api/auth/login',
        async (ctx) => {
            const key = ctx.ip || 'unknown';
            if (limiter.blocked(key)) throw new HttpError(429, 'Too many failed logins. Try again later.');
            const { username, password } = ctx.body || {};
            if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 1024) {
                throw new HttpError(400, 'username and password are required');
            }
            const user = users.getByName(username);
            const usable = user && !user.disabled_at;
            // Always run the hash check so timing does not reveal whether the user name matched.
            const passOk = await verifyPassword(password, usable ? user.password_hash : await dummy());
            if (!(usable && passOk)) {
                limiter.fail(key);
                // An unknown name is not logged: it may be a password typed in the wrong box.
                events.add('warn', 'auth', `Failed login attempt${user ? ` for ${user.username}` : ''}`, { data: { ip: key } });
                throw new HttpError(401, 'Invalid user name or password');
            }
            limiter.reset(key);
            users.recordLogin(user.id);
            const s = sessions.create(user.username, cfg.sessionTtlHours);
            ctx.headers['Set-Cookie'] = sessionCookie(cfg, s.token, s.expiresAt);
            events.add('info', 'auth', `${user.username} logged in`, { actor: user.username, data: { ip: key } });
            return me({ username: user.username, csrfToken: s.csrfToken, mustChangePassword: !!user.must_change_password });
        },
        { auth: false, csrf: false },
    );

    router.post(
        '/api/auth/logout',
        async (ctx) => {
            sessions.destroy(ctx.sessionToken);
            ctx.headers['Set-Cookie'] = clearCookie(cfg);
            return { ok: true };
        },
        { beforePasswordChange: true },
    );

    router.get(
        '/api/auth/me',
        async (ctx) => {
            if (!ctx.session) throw new HttpError(401, 'Not logged in');
            return me(ctx.session);
        },
        { auth: false },
    );

    // A user changes their own password: { current, password }. Their other sessions end.
    router.post(
        '/api/auth/password',
        async (ctx) => {
            const { current, password } = ctx.body || {};
            const user = users.get(ctx.session.userId);
            if (typeof current !== 'string' || !(await verifyPassword(current, user.password_hash))) throw new HttpError(400, 'Your current password is not right.');
            try {
                users.checkPassword(password);
            } catch (err) {
                throw new HttpError(400, err.message);
            }
            if (password === current) throw new HttpError(400, 'Choose a new password, not the one you have now.');
            users.setPassword(user.id, await hashPassword(password), { mustChange: false });
            sessions.destroyForUser(user.username, { keepToken: ctx.sessionToken });
            events.add('info', 'user', `${user.username} changed their password`, { actor: actorOf(ctx) });
            return me({ ...ctx.session, mustChangePassword: false });
        },
        { beforePasswordChange: true },
    );
}
