// Backup schedules (one row per database and backup type).
import { getDb } from '../db.js';
import { nextRun } from '../../engine/schedule-math.js';

const COLS = 'database_id, backup_type, enabled, kind, interval_minutes, at_time, weekday, next_run_at, last_run_at, last_status';

const shape = (r) => r && { ...r, enabled: !!r.enabled };

export function list(databaseId) {
    return getDb()
        .prepare(`SELECT ${COLS} FROM schedules WHERE database_id=? ORDER BY CASE backup_type WHEN 'FULL' THEN 1 WHEN 'DIFF' THEN 2 ELSE 3 END`)
        .all(databaseId)
        .map(shape);
}

export function get(databaseId, type) {
    return shape(getDb().prepare(`SELECT ${COLS} FROM schedules WHERE database_id=? AND backup_type=?`).get(databaseId, type));
}

/** Enabled schedules of managed databases that are due at `now`. */
export function due(now) {
    return getDb()
        .prepare(
            `SELECT s.database_id, s.backup_type, s.kind, s.interval_minutes, s.at_time, s.weekday, s.next_run_at
             FROM schedules AS s JOIN databases AS d ON d.id=s.database_id
             WHERE s.enabled=1 AND d.status='managed' AND (s.next_run_at IS NULL OR s.next_run_at<=?)`,
        )
        .all(now.toISOString());
}

export function update(databaseId, type, v) {
    const next = v.enabled ? nextRun(v, new Date()).toISOString() : null;
    getDb()
        .prepare(
            `UPDATE schedules SET enabled=@enabled, kind=@kind, interval_minutes=@interval_minutes, at_time=@at_time,
                 weekday=@weekday, next_run_at=@next WHERE database_id=@database_id AND backup_type=@type`,
        )
        .run({ ...v, next, database_id: databaseId, type });
    return get(databaseId, type);
}

export function recordRun(databaseId, type, { ranAt, status, nextRunAt }) {
    getDb()
        .prepare('UPDATE schedules SET last_run_at=?, last_status=?, next_run_at=? WHERE database_id=? AND backup_type=?')
        .run(ranAt, status, nextRunAt, databaseId, type);
}

export function setNextRun(databaseId, type, nextRunAt) {
    getDb().prepare('UPDATE schedules SET next_run_at=? WHERE database_id=? AND backup_type=?').run(nextRunAt, databaseId, type);
}
