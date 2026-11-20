// Login sessions. Only a hash of the cookie value is stored.
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

/** Returns the session for a cookie value, or null if unknown/expired. */
export function lookup(token) {
    if (!token) return null;
    const idHash = sha256(token);
    const row = getDb().prepare('SELECT id_hash, username, csrf_token, expires_at FROM sessions WHERE id_hash=?').get(idHash);
    if (!row) return null;
    if (row.expires_at <= nowIso()) {
        destroy(token);
        return null;
    }
    getDb().prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').run(nowIso(), idHash);
    return { idHash, username: row.username, csrfToken: row.csrf_token, expiresAt: row.expires_at };
}

export function destroy(token) {
    if (!token) return;
    getDb().prepare('DELETE FROM sessions WHERE id_hash=?').run(sha256(token));
}

export function purgeExpired() {
    return getDb().prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowIso()).changes;
}
