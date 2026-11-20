import { HttpError } from '../router.js';
import { sessionCookie, clearCookie, LoginLimiter } from '../auth.js';
import { verifyPassword, safeEqual } from '../../crypto.js';
import * as sessions from '../../store/repos/sessions.js';
import * as events from '../../store/repos/events.js';

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
            if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) {
                throw new HttpError(400, 'username and password are required');
            }
            // Always run the hash check so timing does not reveal whether the user name matched.
            const passOk = await verifyPassword(password, cfg.adminPasswordHash);
            const userOk = safeEqual(username, cfg.adminUser);
            if (!(passOk && userOk)) {
                limiter.fail(key);
                events.add('warn', 'auth', 'Failed login attempt', { data: { ip: key } });
                throw new HttpError(401, 'Invalid user name or password');
            }
            limiter.reset(key);
            const s = sessions.create(cfg.adminUser, cfg.sessionTtlHours);
            ctx.headers['Set-Cookie'] = sessionCookie(cfg, s.token, s.expiresAt);
            events.add('info', 'auth', `User ${cfg.adminUser} logged in`, { data: { ip: key } });
            return { user: cfg.adminUser, csrfToken: s.csrfToken };
        },
        { auth: false, csrf: false },
    );

    router.post('/api/auth/logout', async (ctx) => {
        sessions.destroy(ctx.sessionToken);
        ctx.headers['Set-Cookie'] = clearCookie(cfg);
        return { ok: true };
    });

    router.get(
        '/api/auth/me',
        async (ctx) => {
            if (!ctx.session) throw new HttpError(401, 'Not logged in');
            return { user: ctx.session.username, csrfToken: ctx.session.csrfToken };
        },
        { auth: false },
    );
}
