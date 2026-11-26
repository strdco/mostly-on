// Login sessions. Only a hash of the cookie value is stored. A session ends
// when it expires, at logout, or when its user is disabled.
import { getDb, nowIso } from '../db.js';
import { randomToken, sha256 } from '../../crypto.js';

export function create(username, ttlHours) {
    const token = randomToken(32);
    const csrf = randomToken(32);
    const now = new Date();
    const expires = new Date(now.getTime() + ttlHours * 3600_000);
    getDb()
        .prepare(
            `INSERT INTO sessions (id_hash, username, csrf_token, created_at, expires_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(sha256(token), username, csrf, now.toISOString(), expires.toISOString(), now.toISOString());
    return { token, csrfToken: csrf, expiresAt: expires };
}

/** Returns the session for a cookie value, or null if unknown, expired, or its user is disabled or gone. */
export function lookup(token) {
    if (!token) return null;
    const idHash = sha256(token);
    const row = getDb()
        .prepare(
            `SELECT s.id_hash, u.id AS user_id, u.username, u.must_change_password, u.disabled_at, s.csrf_token, s.expires_at
             FROM sessions AS s LEFT JOIN users AS u ON u.username=s.username
             WHERE s.id_hash=?`,
        )
        .get(idHash);
    if (!row) return null;
    if (row.expires_at <= nowIso() || row.user_id == null || row.disabled_at) {
        destroy(token);
        return null;
    }
    getDb().prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').run(nowIso(), idHash);
    return {
        idHash,
        userId: row.user_id,
        username: row.username,
        mustChangePassword: !!row.must_change_password,
        csrfToken: row.csrf_token,
        expiresAt: row.expires_at,
    };
}

/** Ends every session of a user, except the one with keepToken (if given). */
export function destroyForUser(username, { keepToken = null } = {}) {
    const keep = keepToken ? sha256(keepToken) : '';
    return getDb().prepare('DELETE FROM sessions WHERE username=? AND id_hash!=?').run(username, keep).changes;
}

export function destroy(token) {
    if (!token) return;
    getDb().prepare('DELETE FROM sessions WHERE id_hash=?').run(sha256(token));
}

export function purgeExpired() {
    return getDb().prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowIso()).changes;
}
