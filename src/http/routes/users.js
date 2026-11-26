// User accounts. Every user may do everything, including managing the other
// users. Accounts are disabled, never deleted, so the audit trail keeps naming
// real accounts.
import { HttpError, idParam, actorOf } from '../router.js';
import { hashPassword } from '../../crypto.js';
import * as users from '../../store/repos/users.js';
import * as sessions from '../../store/repos/sessions.js';
import * as events from '../../store/repos/events.js';
import { publish } from '../../bus.js';

function mustGet(id) {
    const u = users.get(id);
    if (!u) throw new HttpError(404, 'User not found');
    return u;
}

/** Passwords set here are temporary: the user chooses their own (at least 8 characters) at the next sign-in. */
function checkedPassword(password) {
    try {
        users.checkTemporaryPassword(password);
    } catch (err) {
        throw new HttpError(400, err.message);
    }
    return password;
}

function changed() {
    publish('users.changed', {});
}

export function userRoutes(router) {
    router.get('/api/users', async () => users.list().map(users.publicShape));

    // { username, password }: they choose their own password at their first login.
    router.post('/api/users', async (ctx) => {
        const { username, password } = ctx.body || {};
        if (typeof username !== 'string' || !username.trim()) throw new HttpError(400, 'Enter a user name.');
        const hash = await hashPassword(checkedPassword(password));
        let u;
        try {
            u = users.create({ username: username.trim(), passwordHash: hash, mustChangePassword: true, createdBy: actorOf(ctx) });
        } catch (err) {
            throw new HttpError(409, err.message);
        }
        events.add('info', 'user', `User ${u.username} created`, { actor: actorOf(ctx) });
        changed();
        ctx.status = 201;
        return users.publicShape(u);
    });

    // A new password chosen by someone else: the user is logged out and picks their own at the next login.
    router.post('/api/users/:id/password', async (ctx) => {
        const u = mustGet(idParam(ctx.params.id));
        if (u.id === ctx.session.userId) throw new HttpError(409, 'Change your own password with "Change password" instead.');
        users.setPassword(u.id, await hashPassword(checkedPassword(ctx.body?.password)), { mustChange: true });
        sessions.destroyForUser(u.username);
        events.add('info', 'user', `Password of ${u.username} reset; they choose a new one at their next login`, { actor: actorOf(ctx) });
        changed();
        return users.publicShape(users.get(u.id));
    });

    router.post('/api/users/:id/disable', async (ctx) => {
        const u = mustGet(idParam(ctx.params.id));
        if (u.id === ctx.session.userId) throw new HttpError(409, 'You cannot disable your own account.');
        if (u.disabled_at) return users.publicShape(u);
        if (users.countEnabled() <= 1) throw new HttpError(409, 'At least one user must stay enabled.');
        users.setDisabled(u.id, true);
        sessions.destroyForUser(u.username);
        events.add('warn', 'user', `User ${u.username} disabled; they can no longer log in`, { actor: actorOf(ctx) });
        changed();
        return users.publicShape(users.get(u.id));
    });

    router.post('/api/users/:id/enable', async (ctx) => {
        const u = mustGet(idParam(ctx.params.id));
        if (!u.disabled_at) return users.publicShape(u);
        users.setDisabled(u.id, false);
        events.add('info', 'user', `User ${u.username} enabled again`, { actor: actorOf(ctx) });
        changed();
        return users.publicShape(users.get(u.id));
    });
}
