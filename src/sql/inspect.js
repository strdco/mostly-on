// Read-only inspection of a SQL Server: instance info, database state, msdb history.
import { query, T } from './pool.js';
import * as Q from './tsql.js';

export const guid = (g) => (g ? String(g).trim().toLowerCase() : null);

export async function serverInfo(serverId) {
    const r = await query(serverId, Q.SERVER_INFO);
    const row = r.recordset[0];
    return {
        productVersion: row.product_version,
        majorVersion: Number.parseInt(String(row.product_version).split('.')[0], 10),
        edition: row.edition,
        engineEdition: row.engine_edition,
        defaultDataPath: row.default_data_path,
        defaultLogPath: row.default_log_path,
        serverName: row.server_name,
        utcNow: row.utc_now,
    };
}

export async function databases(serverId) {
    const r = await query(serverId, Q.DATABASES_STATE);
    return r.recordset.map((d) => ({
        name: d.name,
        databaseId: d.database_id,
        state: d.state_desc,
        recoveryModel: d.recovery_model_desc,
        userAccess: d.user_access_desc,
        isInStandby: !!d.is_in_standby,
        isReadOnly: !!d.is_read_only,
        familyGuid: guid(d.family_guid),
        recoveryForkGuid: guid(d.recovery_fork_guid),
        lastLogBackupLsn: d.last_log_backup_lsn,
        redoStartLsn: d.redo_start_lsn,
        redoStartForkGuid: guid(d.redo_start_fork_guid),
    }));
}

export async function dbBackupState(serverId, dbName) {
    const r = await query(serverId, Q.DB_BACKUP_STATE, { db: T.sysname(dbName) });
    const d = r.recordset[0];
    if (!d) return null;
    return {
        name: d.name,
        state: d.state_desc,
        recoveryModel: d.recovery_model_desc,
        isReadOnly: !!d.is_read_only,
        familyGuid: guid(d.family_guid),
        recoveryForkGuid: guid(d.recovery_fork_guid),
        lastLogBackupLsn: d.last_log_backup_lsn,
        differentialBaseLsn: d.differential_base_lsn,
        differentialBaseGuid: guid(d.differential_base_guid),
    };
}

const TYPE_MAP = { D: 'FULL', I: 'DIFF', L: 'LOG' };

/** msdb backupset row -> catalog-shaped object. */
export function normalizeBackupset(r) {
    return {
        backupSetId: r.backup_set_id,
        backup_set_uuid: guid(r.backup_set_uuid),
        type: TYPE_MAP[r.type] || r.type,
        rawType: r.type,
        database_name: r.database_name,
        description: r.description,
        is_copy_only: r.is_copy_only ? 1 : 0,
        has_checksum: r.has_backup_checksums ? 1 : 0,
        is_damaged: !!r.is_damaged,
        size_bytes: r.backup_size === null ? null : Number(r.backup_size),
        first_lsn: r.first_lsn,
        last_lsn: r.last_lsn,
        checkpoint_lsn: r.checkpoint_lsn,
        database_backup_lsn: r.database_backup_lsn,
        differential_base_lsn: r.differential_base_lsn,
        differential_base_guid: guid(r.differential_base_guid),
        family_guid: guid(r.family_guid),
        first_recovery_fork_guid: guid(r.first_recovery_fork_guid),
        recovery_fork_guid: guid(r.last_recovery_fork_guid),
        fork_point_lsn: r.fork_point_lsn,
        backup_start: r.backup_start ? new Date(r.backup_start).toISOString() : null,
        backup_finish: r.backup_finish ? new Date(r.backup_finish).toISOString() : null,
        device: r.physical_device_name,
        deviceType: r.device_type,
    };
}

export async function backupsetByPath(serverId, dbName, sqlPath) {
    const r = await query(serverId, Q.BACKUPSET_BY_PATH, { db: T.sysname(dbName), path: T.nvarchar(sqlPath) });
    return r.recordset[0] ? normalizeBackupset(r.recordset[0]) : null;
}

/**
 * Restore state of a database on a (secondary) server, or null if it does
 * not exist. `position` is the next LSN the database needs: redo_start_lsn,
 * or the last_lsn of the newest restore in msdb when that is not available.
 */
export async function dbRestoreState(serverId, dbName) {
    const r = await query(serverId, Q.DB_RESTORE_STATE, { db: T.sysname(dbName) });
    const d = r.recordset[0];
    if (!d) return null;
    const standby = !!d.is_in_standby;
    const restoring = d.state_desc === 'RESTORING' || standby;
    return {
        name: d.name,
        state: d.state_desc,
        standby,
        restoring,
        userAccess: d.user_access_desc,
        recoveryForkGuid: guid(d.recovery_fork_guid),
        forkPointLsn: d.fork_point_lsn,
        lastLogBackupLsn: d.last_log_backup_lsn,
        familyGuid: guid(d.family_guid),
        redoStartLsn: d.redo_start_lsn,
        forkGuid: guid(d.redo_start_fork_guid),
        lastRestoreUuid: guid(d.last_restore_uuid),
        lastRestoreLsn: d.last_restore_lsn,
        lastRestoreAt: d.last_restore_at ? new Date(d.last_restore_at).toISOString() : null,
        position: restoring ? d.redo_start_lsn || d.last_restore_lsn || null : null,
    };
}

/** RESTORE FILELISTONLY: the database files inside a backup. */
export async function fileList(serverId, sqlPath) {
    const r = await query(serverId, Q.RESTORE_FILELISTONLY, { path: T.nvarchar(sqlPath) }, { timeoutMs: 300_000 });
    return r.recordset.map((f) => ({ logicalName: f.LogicalName, physicalName: f.PhysicalName, type: f.Type, fileId: Number(f.FileId) }));
}

/** RESTORE HEADERONLY, GUID columns only (read by name; LSN columns are not trusted). */
export async function headerOnly(serverId, sqlPath) {
    const r = await query(serverId, Q.RESTORE_HEADERONLY, { path: T.nvarchar(sqlPath) }, { timeoutMs: 120_000 });
    return r.recordset.map((h) => ({
        backupSetGuid: guid(h.BackupSetGUID),
        familyGuid: guid(h.FamilyGUID),
        firstRecoveryForkGuid: guid(h.FirstRecoveryForkID),
        recoveryForkGuid: guid(h.RecoveryForkID),
        backupType: h.BackupType,
    }));
}

/** One entry per backup set (multi-file sets are merged; devices listed). */
export async function backupsetsSince(serverId, dbName, familyGuid, sinceUtc) {
    const r = await query(serverId, Q.BACKUPSETS_SINCE, {
        db: T.sysname(dbName),
        family_guid: T.uniqueidentifier(familyGuid),
        since_utc: T.datetime2(sinceUtc),
    });
    const byUuid = new Map();
    for (const row of r.recordset) {
        const n = normalizeBackupset(row);
        const prev = byUuid.get(n.backup_set_uuid);
        if (prev) prev.devices.push(n.device);
        else byUuid.set(n.backup_set_uuid, { ...n, devices: [n.device] });
    }
    return [...byUuid.values()];
}
