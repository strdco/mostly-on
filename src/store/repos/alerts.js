// Alert state (table notification_state): one row per condition key, kept
// after it resolves so a controller restart never re-sends an alert.
import { getDb } from '../db.js';

const COLS = 'key, kind, severity, status, message, first_seen_at, last_notified_at, resolved_at, database_id, server_id';

export function all() {
    return getDb().prepare(`SELECT ${COLS} FROM notification_state`).all();
}

/** Active alerts first (most severe, oldest first), then recently resolved ones. */
export function list({ status = null, limit = 200 } = {}) {
    const where = status ? 'WHERE status=?' : '';
    const args = status ? [status] : [];
    return getDb()
        .prepare(
            `SELECT ${COLS} FROM notification_state ${where}
             ORDER BY status='active' DESC, CASE WHEN status='active' THEN severity='error' END DESC,
                      CASE WHEN status='active' THEN first_seen_at END, resolved_at DESC
             LIMIT ?`,
        )
        .all(...args, Math.min(Math.max(1, limit | 0), 1000));
}

export function upsert(r) {
    getDb()
        .prepare(
            `INSERT INTO notification_state (${COLS})
             VALUES (@key, @kind, @severity, @status, @message, @first_seen_at, @last_notified_at, @resolved_at, @database_id, @server_id)
             ON CONFLICT (key) DO UPDATE SET kind=excluded.kind, severity=excluded.severity, status=excluded.status, message=excluded.message,
                 first_seen_at=excluded.first_seen_at, last_notified_at=excluded.last_notified_at, resolved_at=excluded.resolved_at,
                 database_id=excluded.database_id, server_id=excluded.server_id`,
        )
        .run(r);
}

export function markNotified(keys, at) {
    const stmt = getDb().prepare('UPDATE notification_state SET last_notified_at=? WHERE key=?');
    getDb().transaction(() => {
        for (const k of keys) stmt.run(at, k);
    })();
}

/** Deletes resolved alerts older than the cutoff whose resolve notice is not pending. */
export function purgeResolved(beforeIso) {
    return getDb()
        .prepare(
            `DELETE FROM notification_state WHERE status='resolved' AND resolved_at<?
               AND (last_notified_at IS NULL OR last_notified_at>=resolved_at)`,
        )
        .run(beforeIso).changes;
}
