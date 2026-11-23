// Backups found in msdb that the controller did not take.
import { getDb, nowIso } from '../db.js';

/**
 * Returns true if the backup set was not known before. acknowledged: noted
 * only, nothing to act on (no alert, no callout).
 */
export function record({ uuid, databaseId, serverId, type, finishAt, device, acknowledged = false }) {
    const now = nowIso();
    return (
        getDb()
            .prepare(
                `INSERT INTO foreign_backups (backup_set_uuid, database_id, server_id, type, finish_at, device, detected_at, acknowledged_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (backup_set_uuid) DO NOTHING`,
            )
            .run(uuid, databaseId, serverId, type, finishAt, device, now, acknowledged ? now : null).changes > 0
    );
}

export function list(databaseId) {
    return getDb()
        .prepare(
            `SELECT f.backup_set_uuid, f.database_id, f.server_id, s.name AS server_name, f.type, f.finish_at, f.device,
                    f.detected_at, f.acknowledged_at
             FROM foreign_backups AS f JOIN servers AS s ON s.id=f.server_id
             WHERE f.database_id=? ORDER BY f.finish_at DESC`,
        )
        .all(databaseId);
}

export function unacknowledged(databaseId) {
    return getDb()
        .prepare("SELECT COUNT(*) FROM foreign_backups WHERE database_id=? AND acknowledged_at IS NULL AND type='LOG'")
        .pluck()
        .get(databaseId);
}

/** Every unacknowledged foreign backup of a managed database (any type). */
export function allUnacknowledged() {
    return getDb()
        .prepare(
            `SELECT f.backup_set_uuid, f.database_id, d.name AS database_name, d.backup_only_server_id, f.server_id, s.name AS server_name, f.type, f.finish_at, f.device
             FROM foreign_backups AS f JOIN servers AS s ON s.id=f.server_id JOIN databases AS d ON d.id=f.database_id
             WHERE f.acknowledged_at IS NULL AND d.status='managed' ORDER BY f.finish_at`,
        )
        .all();
}

export function isKnown(uuid) {
    return !!getDb().prepare('SELECT 1 FROM foreign_backups WHERE backup_set_uuid=?').get(uuid);
}

export function acknowledge(uuid) {
    return getDb().prepare('UPDATE foreign_backups SET acknowledged_at=? WHERE backup_set_uuid=? AND acknowledged_at IS NULL').run(nowIso(), uuid).changes > 0;
}
