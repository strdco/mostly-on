// Journal of operations (backups, seeds, failovers ...). Each operation has an
// ordered list of steps; the runner in engine/operations.js persists progress
// here before and after every step.
import { getDb, nowIso } from '../db.js';

const COLS = 'id, type, database_id, server_id, parent_id, params, status, current_step, steps, ctx, error, created_by, created_at, updated_at, finished_at';

function shape(r) {
    if (!r) return r;
    return { ...r, params: JSON.parse(r.params), steps: JSON.parse(r.steps), ctx: JSON.parse(r.ctx) };
}

/** createdBy: the user who started it (NULL = Mostly-On itself); a child operation inherits its parent's. */
export function create({ type, databaseId = null, serverId = null, parentId = null, params = {}, steps = [], ctx = {}, status = 'running', createdBy = null }) {
    const now = nowIso();
    if (createdBy == null && parentId != null) createdBy = createdByOf(parentId);
    const info = getDb()
        .prepare(
            `INSERT INTO operations (type, database_id, server_id, parent_id, params, status, steps, ctx, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(type, databaseId, serverId, parentId, JSON.stringify(params), status, JSON.stringify(steps), JSON.stringify(ctx), createdBy, now, now);
    return get(Number(info.lastInsertRowid));
}

/** The user who started an operation, or null (Mostly-On itself, or no such operation). */
export function createdByOf(id) {
    return getDb().prepare('SELECT created_by FROM operations WHERE id=?').pluck().get(id) ?? null;
}

export function get(id) {
    return shape(getDb().prepare(`SELECT ${COLS} FROM operations WHERE id=?`).get(id));
}

/** Persist any subset of: status, current_step, steps, ctx, error, finished_at. */
export function save(id, patch) {
    const cols = [];
    const args = {};
    for (const k of ['status', 'current_step', 'error', 'finished_at']) {
        if (patch[k] !== undefined) {
            cols.push(`${k}=@${k}`);
            args[k] = patch[k];
        }
    }
    for (const k of ['steps', 'ctx']) {
        if (patch[k] !== undefined) {
            cols.push(`${k}=@${k}`);
            args[k] = JSON.stringify(patch[k]);
        }
    }
    cols.push('updated_at=@now');
    args.now = nowIso();
    args.id = id;
    getDb().prepare(`UPDATE operations SET ${cols.join(', ')} WHERE id=@id`).run(args);
    return get(id);
}

/** Operations of the given types on a database that were started after operation afterId. */
export function laterForDatabase(databaseId, afterId, types) {
    return getDb()
        .prepare(`SELECT ${COLS} FROM operations WHERE database_id=? AND id>? AND type IN (${types.map(() => '?').join(', ')}) ORDER BY id`)
        .all(databaseId, afterId, ...types)
        .map(shape);
}

/**
 * @param {{status?:string[], type?:string, databaseId?:number, includeRoutine?:boolean, limit?:number, beforeId?:number}} f
 * "Routine" = scheduled backups that succeeded; hidden by default to keep the list readable.
 */
export function list(f = {}) {
    const where = [];
    const args = [];
    if (f.status?.length) {
        where.push(`status IN (${f.status.map(() => '?').join(',')})`);
        args.push(...f.status);
    }
    if (f.type) {
        where.push('type=?');
        args.push(f.type);
    }
    if (f.databaseId) {
        where.push('database_id=?');
        args.push(f.databaseId);
    }
    if (f.beforeId) {
        where.push('id<?');
        args.push(f.beforeId);
    }
    if (!f.includeRoutine) {
        where.push("NOT (type='backup' AND status='succeeded' AND json_extract(params, '$.trigger')='schedule')");
    }
    return getDb()
        .prepare(`SELECT ${COLS} FROM operations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
        .all(...args, Math.min(Math.max(1, f.limit | 0 || 100), 1000))
        .map(shape);
}

export function unfinished() {
    return getDb().prepare(`SELECT ${COLS} FROM operations WHERE status IN ('queued', 'running') ORDER BY id`).all().map(shape);
}

/**
 * Per managed database and backup type: the newest failed or interrupted
 * backup, if no backup of that type was cataloged after it.
 */
export function failedBackups() {
    return getDb()
        .prepare(
            `WITH failed AS (
                 SELECT o.id, o.database_id, json_extract(o.params, '$.type') AS backup_type, o.error, o.status, o.created_at,
                        ROW_NUMBER() OVER (PARTITION BY o.database_id, json_extract(o.params, '$.type') ORDER BY o.id DESC) AS rn
                 FROM operations AS o JOIN databases AS d ON d.id=o.database_id AND d.status='managed'
                 WHERE o.type='backup' AND o.status IN ('failed', 'interrupted')
                   AND json_extract(o.ctx, '$.gaveWay') IS NULL)
             SELECT f.id, f.database_id, f.backup_type, f.error, f.status, f.created_at
             FROM failed AS f
             WHERE f.rn=1
               AND f.created_at>COALESCE((SELECT MAX(b.created_at) FROM backup_files AS b WHERE b.database_id=f.database_id AND b.type=f.backup_type), '')`,
        )
        .all();
}

/** Top-level non-backup operations (seeds, failovers ...) that failed or were interrupted and are not resolved. */
export function needingAttention() {
    return getDb()
        .prepare(`SELECT ${COLS} FROM operations WHERE type!='backup' AND parent_id IS NULL AND status IN ('failed', 'interrupted') ORDER BY id`)
        .all()
        .map(shape);
}

/** Deletes routine backup operations older than the cutoff. */
export function purgeRoutine(beforeIso) {
    return getDb()
        .prepare(
            `DELETE FROM operations WHERE type='backup' AND status='succeeded' AND finished_at<?
               AND id NOT IN (SELECT operation_id FROM backup_files WHERE operation_id IS NOT NULL AND type!='LOG')`,
        )
        .run(beforeIso).changes;
}
