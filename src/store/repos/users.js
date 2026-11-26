// Named user accounts. Users are disabled, never deleted, so the names in the
// audit trail (events.actor, operations.created_by) keep their meaning.
import { getDb, nowIso } from '../db.js';

const COLS = 'id, username, password_hash, must_change_password, created_at, created_by, disabled_at, last_login_at';

/** Same rule as ADMIN_USER in config.js. */
export const USERNAME_RE = /^[A-Za-z0-9_.@-]{1,64}$/;
export const MIN_PASSWORD_LENGTH = 8;

/** Throws a plain explanation if a password a user chooses for themselves is not acceptable. */
export function checkPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password.length > 1024) throw new Error('That password is too long.');
}

/**
 * A password someone else sets (a new account, a reset): only used once, as
 * the user must choose their own at the next sign-in, so it only may not be blank.
 */
export function checkTemporaryPassword(password) {
    if (typeof password !== 'string' || !password.trim()) throw new Error('Enter a password.');
    if (password.length > 1024) throw new Error('That password is too long.');
}

/** Without the password hash, for the API. */
export function publicShape(u) {
    if (!u) return u;
    return {
        id: u.id,
        username: u.username,
        mustChangePassword: !!u.must_change_password,
        createdAt: u.created_at,
        createdBy: u.created_by,
        disabledAt: u.disabled_at,
        lastLoginAt: u.last_login_at,
    };
}

export function count() {
    return getDb().prepare('SELECT COUNT(*) FROM users').pluck().get();
}

export function countEnabled() {
    return getDb().prepare('SELECT COUNT(*) FROM users WHERE disabled_at IS NULL').pluck().get();
}

export function get(id) {
    return getDb().prepare(`SELECT ${COLS} FROM users WHERE id=?`).get(id);
}

/** Case-insensitive. */
export function getByName(username) {
    return getDb().prepare(`SELECT ${COLS} FROM users WHERE username=?`).get(username);
}

export function list() {
    return getDb().prepare(`SELECT ${COLS} FROM users ORDER BY disabled_at IS NOT NULL, username`).all();
}

export function create({ username, passwordHash, mustChangePassword = true, createdBy = null }) {
    if (!USERNAME_RE.test(username)) throw new Error('A user name may only contain letters, digits and _ . @ - (at most 64 characters).');
    if (getByName(username)) throw new Error(`There is already a user named ${username}.`);
    const info = getDb()
        .prepare('INSERT INTO users (username, password_hash, must_change_password, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(username, passwordHash, mustChangePassword ? 1 : 0, nowIso(), createdBy);
    return get(Number(info.lastInsertRowid));
}

export function setPassword(id, passwordHash, { mustChange }) {
    getDb().prepare('UPDATE users SET password_hash=?, must_change_password=? WHERE id=?').run(passwordHash, mustChange ? 1 : 0, id);
}

export function setDisabled(id, disabled) {
    getDb()
        .prepare('UPDATE users SET disabled_at=? WHERE id=?')
        .run(disabled ? nowIso() : null, id);
}

export function recordLogin(id) {
    getDb().prepare('UPDATE users SET last_login_at=? WHERE id=?').run(nowIso(), id);
}

/**
 * On a catalog without users, creates the first one from ADMIN_USER and
 * ADMIN_PASSWORD_HASH (it keeps that password: it was chosen by whoever set
 * up Mostly-On). Afterwards those variables are not used.
 * @returns {'created'|'exists'}
 */
export function ensureFirstUser({ adminUser, adminPasswordHash }) {
    if (count() > 0) return 'exists';
    if (!adminPasswordHash) {
        throw new Error('There are no users yet. Set ADMIN_USER and ADMIN_PASSWORD_HASH for the first one (generate the hash with: npm run hash-password).');
    }
    create({ username: adminUser, passwordHash: adminPasswordHash, mustChangePassword: false, createdBy: null });
    return 'created';
}
