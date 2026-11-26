// Backup schedules (one row per database and backup type).
//
// A row follows the default schedule of its type (Settings) until someone
// edits it on the database's page; then it is the database's own until they
// switch it back to the default. follows_default=1 rows are kept equal to the
// default by applyDefaults().
import { getDb } from '../db.js';
import { nextRun } from '../../engine/schedule-math.js';
import * as settings from './settings.js';

const COLS = 'database_id, backup_type, enabled, follows_default, kind, interval_minutes, at_time, weekday, next_run_at, last_run_at, last_status';

const shape = (r) => r && { ...r, enabled: !!r.enabled, follows_default: !!r.follows_default };

export const DEFAULT_SCHEDULE_KEYS = Object.freeze([
    ['FULL', 'schedule.default_full'],
    ['DIFF', 'schedule.default_diff'],
    ['LOG', 'schedule.default_log'],
]);
const TYPES = DEFAULT_SCHEDULE_KEYS.map(([type]) => type);
const KEY = Object.fromEntries(DEFAULT_SCHEDULE_KEYS);

/**
 * The default schedule of `type` as schedule columns. Only the DIFF default
 * can be off; a stored default without `enabled` is on, as it was before that
 * switch existed.
 */
export function defaultFor(type) {
    const d = settings.get(KEY[type]);
    return {
        enabled: type !== 'DIFF' || d.enabled !== false ? 1 : 0,
        kind: d.kind,
        interval_minutes: d.interval_minutes ?? null,
        at_time: d.at_time ?? null,
        weekday: d.weekday ?? null,
    };
}

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

/** Gives the database its own schedule of `type`: it no longer follows the default. */
export function update(databaseId, type, v) {
    const next = v.enabled ? nextRun(v, new Date()).toISOString() : null;
    getDb()
        .prepare(
            `UPDATE schedules SET enabled=@enabled, follows_default=0, kind=@kind, interval_minutes=@interval_minutes, at_time=@at_time,
                 weekday=@weekday, next_run_at=@next WHERE database_id=@database_id AND backup_type=@type`,
        )
        .run({ ...v, next, database_id: databaseId, type });
    return get(databaseId, type);
}

/** The database's schedule of `type` follows the default again (and is created if it is missing). */
export function useDefault(databaseId, type, now = new Date()) {
    const d = defaultFor(type);
    getDb()
        .prepare(
            `INSERT INTO schedules (database_id, backup_type, enabled, follows_default, kind, interval_minutes, at_time, weekday, next_run_at)
             VALUES (@database_id, @type, @enabled, 1, @kind, @interval_minutes, @at_time, @weekday, @next)
             ON CONFLICT (database_id, backup_type) DO UPDATE SET enabled=excluded.enabled, follows_default=1, kind=excluded.kind,
                 interval_minutes=excluded.interval_minutes, at_time=excluded.at_time, weekday=excluded.weekday, next_run_at=excluded.next_run_at`,
        )
        .run({ ...d, database_id: databaseId, type, next: d.enabled ? nextRun(d, now).toISOString() : null });
    return get(databaseId, type);
}

/**
 * Brings the schedules of managed databases that follow the default of each
 * of `types` in line with it. Rows that already match keep their next run.
 * Returns { FULL: [databaseId, ...], ... } for the rows it changed.
 */
export function applyDefaults(types = TYPES, now = new Date()) {
    const stmt = getDb().prepare(
        `UPDATE schedules SET enabled=@enabled, kind=@kind, interval_minutes=@interval_minutes, at_time=@at_time, weekday=@weekday, next_run_at=@next
         WHERE backup_type=@type AND follows_default=1
           AND database_id IN (SELECT id FROM databases WHERE status='managed')
           AND (enabled IS NOT @enabled OR kind IS NOT @kind OR interval_minutes IS NOT @interval_minutes OR at_time IS NOT @at_time OR weekday IS NOT @weekday)
         RETURNING database_id`,
    );
    const changed = {};
    for (const type of types) {
        const d = defaultFor(type);
        changed[type] = stmt.pluck().all({ ...d, type, next: d.enabled ? nextRun(d, now).toISOString() : null });
    }
    return changed;
}

/**
 * Which managed databases follow each default: { FULL: { follows: n, own: [{ id, name }] }, ... }.
 * `own`: the databases with their own schedule of that type, by name ("master on sql1" for backups-only ones).
 */
export function defaultUse() {
    const out = Object.fromEntries(TYPES.map((t) => [t, { follows: 0, own: [] }]));
    const rows = getDb()
        .prepare(
            `SELECT s.backup_type, s.follows_default, d.id, d.name, bs.name AS server_name
             FROM schedules AS s JOIN databases AS d ON d.id=s.database_id LEFT JOIN servers AS bs ON bs.id=d.backup_only_server_id
             WHERE d.status='managed' ORDER BY d.name COLLATE NOCASE, bs.name`,
        )
        .all();
    for (const r of rows) {
        if (r.follows_default) out[r.backup_type].follows++;
        else out[r.backup_type].own.push({ id: r.id, name: r.server_name ? `${r.name} on ${r.server_name}` : r.name });
    }
    return out;
}

export function recordRun(databaseId, type, { ranAt, status, nextRunAt }) {
    getDb()
        .prepare('UPDATE schedules SET last_run_at=?, last_status=?, next_run_at=? WHERE database_id=? AND backup_type=?')
        .run(ranAt, status, nextRunAt, databaseId, type);
}

export function setNextRun(databaseId, type, nextRunAt) {
    getDb().prepare('UPDATE schedules SET next_run_at=? WHERE database_id=? AND backup_type=?').run(nextRunAt, databaseId, type);
}
