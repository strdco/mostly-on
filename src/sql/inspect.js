// Read-only inspection of a SQL Server: instance info, database state, msdb history.
import { query } from './pool.js';
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
        dataBytes: d.data_bytes === null ? null : Number(d.data_bytes),
        logBytes: d.log_bytes === null ? null : Number(d.log_bytes),
        redoStartLsn: d.redo_start_lsn,
        redoStartForkGuid: guid(d.redo_start_fork_guid),
    }));
}
