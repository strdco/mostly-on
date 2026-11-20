// Catalog of backup files on the shared volume.
import { getDb, nowIso } from '../db.js';

const COLS = `id, database_id, server_id, type, rel_path, first_lsn, last_lsn, checkpoint_lsn, database_backup_lsn,
    differential_base_lsn, differential_base_guid, family_guid, recovery_fork_guid, first_recovery_fork_guid,
    fork_point_lsn, backup_set_uuid, backup_start, backup_finish, size_bytes, has_checksum, is_tail, is_copy_only,
    file_status, deleted_at, operation_id, created_at`;

export function insert(f) {
    const info = getDb()
        .prepare(
            `INSERT INTO backup_files (database_id, server_id, type, rel_path, first_lsn, last_lsn, checkpoint_lsn,
                database_backup_lsn, differential_base_lsn, differential_base_guid, family_guid, recovery_fork_guid,
                first_recovery_fork_guid, fork_point_lsn, backup_set_uuid, backup_start, backup_finish, size_bytes,
                has_checksum, is_tail, is_copy_only, file_status, operation_id, created_at)
             VALUES (@database_id, @server_id, @type, @rel_path, @first_lsn, @last_lsn, @checkpoint_lsn,
                @database_backup_lsn, @differential_base_lsn, @differential_base_guid, @family_guid, @recovery_fork_guid,
                @first_recovery_fork_guid, @fork_point_lsn, @backup_set_uuid, @backup_start, @backup_finish, @size_bytes,
                @has_checksum, @is_tail, @is_copy_only, 'present', @operation_id, @created_at)`,
        )
        .run({
            is_tail: 0,
            operation_id: null,
            fork_point_lsn: null,
            differential_base_lsn: null,
            differential_base_guid: null,
            ...f,
            created_at: nowIso(),
        });
    return get(Number(info.lastInsertRowid));
}

export function get(id) {
    return getDb().prepare(`SELECT ${COLS} FROM backup_files WHERE id=?`).get(id);
}

export function byRelPath(relPath) {
    return getDb().prepare(`SELECT ${COLS} FROM backup_files WHERE rel_path=?`).get(relPath);
}

export function byUuid(uuid) {
    return getDb().prepare(`SELECT ${COLS} FROM backup_files WHERE backup_set_uuid=?`).get(uuid);
}

export function list({ databaseId, type, limit = 200, includeDeleted = true } = {}) {
    const where = ['database_id=?'];
    const args = [databaseId];
    if (type) {
        where.push('type=?');
        args.push(type);
    }
    if (!includeDeleted) where.push("file_status='present'");
    return getDb()
        .prepare(`SELECT ${COLS} FROM backup_files WHERE ${where.join(' AND ')} ORDER BY backup_finish DESC, id DESC LIMIT ?`)
        .all(...args, Math.min(Math.max(1, limit | 0), 5000));
}

/** Every file of a database that is still on disk (for chain and retention logic). */
export function present(databaseId) {
    return getDb().prepare(`SELECT ${COLS} FROM backup_files WHERE database_id=? AND file_status='present' ORDER BY backup_finish, id`).all(databaseId);
}

/** Every catalog row of a database, including missing and deleted files (for chain decisions). */
export function all(databaseId) {
    return getDb().prepare(`SELECT ${COLS} FROM backup_files WHERE database_id=? ORDER BY backup_finish, id`).all(databaseId);
}

export function latestByType(databaseId) {
    const rows = getDb()
        .prepare(
            `SELECT b.type, b.id, b.backup_finish, b.rel_path, b.size_bytes, b.server_id
             FROM backup_files AS b
             WHERE b.database_id=? AND b.id IN (
                 SELECT MAX(x.id) FROM backup_files AS x WHERE x.database_id=b.database_id GROUP BY x.type)`,
        )
        .all(databaseId);
    return Object.fromEntries(rows.map((r) => [r.type, r]));
}

/** Newest non-copy-only FULL of this family that is still on disk. */
export function latestFull(databaseId, familyGuid) {
    return getDb()
        .prepare(
            `SELECT ${COLS} FROM backup_files WHERE database_id=? AND type='FULL' AND file_status='present'
               AND is_copy_only=0 AND (? IS NULL OR family_guid=?) ORDER BY backup_finish DESC, id DESC LIMIT 1`,
        )
        .get(databaseId, familyGuid, familyGuid);
}

export function markStatus(id, status) {
    getDb()
        .prepare('UPDATE backup_files SET file_status=?, deleted_at=? WHERE id=?')
        .run(status, status === 'deleted' ? nowIso() : null, id);
}
