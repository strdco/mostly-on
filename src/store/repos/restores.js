// History of restores onto secondaries (one row per RESTORE statement).
import { getDb, nowIso } from '../db.js';

const COLS = `r.id, r.backup_file_id, r.database_id, r.server_id, s.name AS server_name, r.started_at, r.finished_at,
    r.outcome, r.error, r.operation_id, b.type AS backup_type, b.rel_path, b.first_lsn, b.last_lsn, b.backup_finish`;

const FROM = 'FROM restores AS r JOIN servers AS s ON s.id=r.server_id JOIN backup_files AS b ON b.id=r.backup_file_id';

export function start({ backupFileId, databaseId, serverId, operationId = null }) {
    const info = getDb()
        .prepare(
            `INSERT INTO restores (backup_file_id, database_id, server_id, started_at, outcome, operation_id)
             VALUES (?, ?, ?, ?, 'running', ?)`,
        )
        .run(backupFileId, databaseId, serverId, nowIso(), operationId);
    return Number(info.lastInsertRowid);
}

export function finish(id, outcome, error = null) {
    getDb()
        .prepare('UPDATE restores SET outcome=?, error=?, finished_at=? WHERE id=?')
        .run(outcome, error ? String(error).slice(0, 2000) : null, nowIso(), id);
}

export function get(id) {
    return getDb().prepare(`SELECT ${COLS} ${FROM} WHERE r.id=?`).get(id);
}

export function list({ databaseId, serverId, limit = 100 } = {}) {
    const where = ['r.database_id=?'];
    const args = [databaseId];
    if (serverId) {
        where.push('r.server_id=?');
        args.push(serverId);
    }
    return getDb()
        .prepare(`SELECT ${COLS} ${FROM} WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`)
        .all(...args, Math.min(Math.max(1, limit | 0), 1000));
}

/** Startup: restores that were running when the controller stopped. */
export function markInterrupted() {
    return getDb()
        .prepare("UPDATE restores SET outcome='interrupted', error='Controller stopped during the restore', finished_at=? WHERE outcome='running'")
        .run(nowIso()).changes;
}
