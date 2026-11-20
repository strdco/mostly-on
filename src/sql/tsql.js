// Every T-SQL statement the controller sends lives in this file.
//
// Rules:
//  * Values (database names, paths, LSNs) are always @parameters.
//  * BACKUP/RESTORE accept @variables for database names and devices, so they
//    are fully parameterized.
//  * Statements that cannot take a variable for an object name (ALTER DATABASE,
//    DROP DATABASE) build their dynamic SQL server-side with QUOTENAME(@db).
//  * LSN columns are CAST to varchar(25) because the driver would otherwise
//    turn numeric(25,0) into a lossy JS number.
//  * msdb datetimes are server-local; they are converted to UTC datetime2 here.

// Converts a server-local datetime column to UTC datetime2(3).
const utc = (col) => `CONVERT(datetime2(3), SWITCHOFFSET(TODATETIMEOFFSET(${col}, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())), 0))`;

export const SERVER_INFO = `
SELECT CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')) AS product_version,
       CONVERT(nvarchar(128), SERVERPROPERTY(N'Edition')) AS edition,
       CONVERT(int, SERVERPROPERTY(N'EngineEdition')) AS engine_edition,
       CONVERT(nvarchar(260), SERVERPROPERTY(N'InstanceDefaultDataPath')) AS default_data_path,
       CONVERT(nvarchar(260), SERVERPROPERTY(N'InstanceDefaultLogPath')) AS default_log_path,
       CONVERT(nvarchar(128), @@SERVERNAME) AS server_name,
       SYSUTCDATETIME() AS utc_now;`;

// One row per user database with everything the health/shipping logic needs.
// redo_start_lsn/redo_start_fork_guid are only populated while RESTORING.
export const DATABASES_STATE = `
SELECT d.name,
       d.database_id,
       d.state_desc,
       d.recovery_model_desc,
       d.user_access_desc,
       d.is_in_standby,
       d.is_read_only,
       CONVERT(char(36), drs.family_guid) AS family_guid,
       CONVERT(char(36), drs.recovery_fork_guid) AS recovery_fork_guid,
       CAST(drs.last_log_backup_lsn AS varchar(25)) AS last_log_backup_lsn,
       CAST(files.redo_start_lsn AS varchar(25)) AS redo_start_lsn,
       files.redo_start_fork_guid
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id=d.database_id
OUTER APPLY (
    SELECT MIN(CASE WHEN mf.type=0 THEN mf.redo_start_lsn END) AS redo_start_lsn,
           MIN(CASE WHEN mf.type=0 AND mf.file_id=1 THEN CONVERT(char(36), mf.redo_start_fork_guid) END) AS redo_start_fork_guid
    FROM sys.master_files AS mf
    WHERE mf.database_id=d.database_id
    ) AS files
WHERE d.database_id>4
ORDER BY d.name;`;

export { utc };

// --- backup engine ----------------------------------------------------------

// Fresh state of one database on its primary, right before a backup.
// differential_base_* identify the FULL a DIFF taken now would be based on.
export const DB_BACKUP_STATE = `
SELECT d.name,
       d.state_desc,
       d.recovery_model_desc,
       d.is_read_only,
       CONVERT(char(36), drs.family_guid) AS family_guid,
       CONVERT(char(36), drs.recovery_fork_guid) AS recovery_fork_guid,
       CAST(drs.last_log_backup_lsn AS varchar(25)) AS last_log_backup_lsn,
       CAST(mf.differential_base_lsn AS varchar(25)) AS differential_base_lsn,
       CONVERT(char(36), mf.differential_base_guid) AS differential_base_guid
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id=d.database_id
LEFT JOIN sys.master_files AS mf ON mf.database_id=d.database_id AND mf.file_id=1
WHERE d.name=@db;`;

// All backups: CHECKSUM + INIT, never COMPRESSION. NO_COMPRESSION is explicit so
// a non-Express instance with "backup compression default" on behaves the same.
// DESCRIPTION tags the backup as ours in msdb (used for foreign-backup detection
// and for recovering catalog entries after a crash).
const BACKUP_OPTS = 'CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10';
export const BACKUP = {
    FULL: `BACKUP DATABASE @db TO DISK=@path WITH ${BACKUP_OPTS};`,
    DIFF: `BACKUP DATABASE @db TO DISK=@path WITH DIFFERENTIAL, ${BACKUP_OPTS};`,
    LOG: `BACKUP LOG @db TO DISK=@path WITH ${BACKUP_OPTS};`,
};

const BACKUPSET_COLUMNS = `
       bs.backup_set_id,
       CONVERT(char(36), bs.backup_set_uuid) AS backup_set_uuid,
       bs.type,
       bs.database_name,
       bs.description,
       bs.is_copy_only,
       bs.has_backup_checksums,
       bs.is_damaged,
       CAST(bs.backup_size AS bigint) AS backup_size,
       CAST(bs.first_lsn AS varchar(25)) AS first_lsn,
       CAST(bs.last_lsn AS varchar(25)) AS last_lsn,
       CAST(bs.checkpoint_lsn AS varchar(25)) AS checkpoint_lsn,
       CAST(bs.database_backup_lsn AS varchar(25)) AS database_backup_lsn,
       CAST(bs.differential_base_lsn AS varchar(25)) AS differential_base_lsn,
       CONVERT(char(36), bs.differential_base_guid) AS differential_base_guid,
       CONVERT(char(36), bs.family_guid) AS family_guid,
       CONVERT(char(36), bs.first_recovery_fork_guid) AS first_recovery_fork_guid,
       CONVERT(char(36), bs.last_recovery_fork_guid) AS last_recovery_fork_guid,
       CAST(bs.fork_point_lsn AS varchar(25)) AS fork_point_lsn,
       ${utc('bs.backup_start_date')} AS backup_start,
       ${utc('bs.backup_finish_date')} AS backup_finish,
       bmf.physical_device_name,
       bmf.device_type`;

// The backup set written to a given file (newest first, in case of reuse).
export const BACKUPSET_BY_PATH = `
SELECT TOP (1) ${BACKUPSET_COLUMNS}
FROM msdb.dbo.backupset AS bs
INNER JOIN msdb.dbo.backupmediafamily AS bmf ON bmf.media_set_id=bs.media_set_id
WHERE bs.database_name=@db
  AND bmf.physical_device_name=@path
ORDER BY bs.backup_set_id DESC;`;

// Every backup of a database (identified by family_guid, because msdb keeps
// history of dropped databases with the same name) finished after @since_utc.
export const BACKUPSETS_SINCE = `
SELECT ${BACKUPSET_COLUMNS}
FROM msdb.dbo.backupset AS bs
INNER JOIN msdb.dbo.backupmediafamily AS bmf ON bmf.media_set_id=bs.media_set_id
WHERE bs.database_name=@db
  AND bs.family_guid=@family_guid
  AND bs.backup_finish_date>=DATEADD(minute, DATEDIFF(minute, SYSUTCDATETIME(), SYSDATETIME()), @since_utc)
ORDER BY bs.backup_set_id;`;

// Optional msdb history cleanup (Agent would normally do this).
export const PURGE_BACKUP_HISTORY = `
DECLARE @oldest datetime2(0)=DATEADD(day, -@keep_days, GETDATE());
EXEC msdb.dbo.sp_delete_backuphistory @oldest_date=@oldest;`;

// --- shipping and restore ---------------------------------------------------

// Live restore state of one database on a secondary. redo_start_lsn is the
// next LSN the database needs; it is exact both in RESTORING and in STANDBY.
// The newest msdb restorehistory entry is returned as a cross-check and as a
// fallback position.
export const DB_RESTORE_STATE = `
SELECT d.name,
       d.state_desc,
       d.is_in_standby,
       d.user_access_desc,
       CONVERT(char(36), drs.family_guid) AS family_guid,
       CONVERT(char(36), drs.recovery_fork_guid) AS recovery_fork_guid,
       CAST(drs.fork_point_lsn AS varchar(25)) AS fork_point_lsn,
       CAST(drs.last_log_backup_lsn AS varchar(25)) AS last_log_backup_lsn,
       CAST(mf.redo_start_lsn AS varchar(25)) AS redo_start_lsn,
       CONVERT(char(36), mf.redo_start_fork_guid) AS redo_start_fork_guid,
       CONVERT(char(36), lr.backup_set_uuid) AS last_restore_uuid,
       CAST(lr.last_lsn AS varchar(25)) AS last_restore_lsn,
       ${utc('lr.restore_date')} AS last_restore_at
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id=d.database_id
LEFT JOIN sys.master_files AS mf ON mf.database_id=d.database_id AND mf.file_id=1
OUTER APPLY (
    SELECT TOP (1) bs.backup_set_uuid, bs.last_lsn, rh.restore_date
    FROM msdb.dbo.restorehistory AS rh
    INNER JOIN msdb.dbo.backupset AS bs ON bs.backup_set_id=rh.backup_set_id
    WHERE rh.destination_database_name=d.name
    ORDER BY rh.restore_history_id DESC
    ) AS lr
WHERE d.name=@db;`;

export const RESTORE_FILELISTONLY = 'RESTORE FILELISTONLY FROM DISK=@path;';

// Disconnects every other session using the database (STANDBY readers, or
// users of a database that is about to be overwritten).
const KILL_SESSIONS = `
DECLARE @kill nvarchar(max);

SELECT @kill=STRING_AGG(CAST(N'KILL '+CONVERT(nvarchar(11), s.session_id)+N';' AS nvarchar(max)), N'')
FROM sys.dm_exec_sessions AS s
WHERE s.database_id=DB_ID(@db)
  AND s.session_id!=@@SPID;

IF (@kill IS NOT NULL) EXEC sys.sp_executesql @kill;
`;

// Takes an existing database offline before a confirmed overwrite. RESTORE
// ... WITH REPLACE then replaces it.
export const SET_OFFLINE = `
DECLARE @sql nvarchar(max)=N'ALTER DATABASE '+QUOTENAME(@db)+N' SET OFFLINE WITH ROLLBACK IMMEDIATE;';
EXEC sys.sp_executesql @sql;`;

/**
 * RESTORE DATABASE of a FULL or DIFF backup, always WITH NORECOVERY. The
 * statement has one MOVE clause per file, bound to @move_from<i>/@move_to<i>;
 * only the number of clauses comes from JS, never a name or path.
 */
export function restoreDatabase({ moveCount = 0, replace = false } = {}) {
    const opts = ['NORECOVERY', 'CHECKSUM', 'STATS=10'];
    if (replace) opts.push('REPLACE');
    for (let i = 0; i < moveCount; i++) opts.push(`MOVE @move_from${i} TO @move_to${i}`);
    return `RESTORE DATABASE @db FROM DISK=@path WITH ${opts.join(', ')};`;
}

// --- failover ------------------------------------------------------------------

// Planned failover tail: one batch on a dedicated connection. SINGLE_USER
// WITH ROLLBACK IMMEDIATE ends every other session, then the tail-log backup
// WITH NORECOVERY leaves the old primary RESTORING, so nothing can write to it
// afterwards. The SINGLE_USER setting travels in the tail log.
export const TAIL_LOG_PLANNED = `
DECLARE @sql nvarchar(max)=N'ALTER DATABASE '+QUOTENAME(@db)+N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE;';
EXEC sys.sp_executesql @sql;

BACKUP LOG @db TO DISK=@path WITH NORECOVERY, ${BACKUP_OPTS};`;

/** Forced failover tail of a possibly damaged primary (best effort). */
export function tailLogForced({ continueAfterError = false } = {}) {
    return `BACKUP LOG @db TO DISK=@path WITH NO_TRUNCATE, NORECOVERY, ${continueAfterError ? 'CONTINUE_AFTER_ERROR, ' : ''}${BACKUP_OPTS};`;
}

export const RESTORE_WITH_RECOVERY = 'RESTORE DATABASE @db WITH RECOVERY;';

export const SET_MULTI_USER = `
DECLARE @sql nvarchar(max)=N'ALTER DATABASE '+QUOTENAME(@db)+N' SET MULTI_USER;';
EXEC sys.sp_executesql @sql;`;

// Brings an OFFLINE (diverged) database back for a safety backup, letting
// only administrators in.
export const SET_ONLINE_RESTRICTED = `
DECLARE @sql nvarchar(max)=N'ALTER DATABASE '+QUOTENAME(@db)+N' SET ONLINE; ALTER DATABASE '+QUOTENAME(@db)+N' SET RESTRICTED_USER WITH ROLLBACK IMMEDIATE;';
EXEC sys.sp_executesql @sql;`;

/** COPY_ONLY safety backup of a diverged copy before it is overwritten. */
export function safetyBackup({ continueAfterError = false } = {}) {
    return `BACKUP DATABASE @db TO DISK=@path WITH COPY_ONLY, ${continueAfterError ? 'CONTINUE_AFTER_ERROR, ' : ''}${BACKUP_OPTS};`;
}

// Only used for its GUID columns (its LSN columns lose precision in the driver).
export const RESTORE_HEADERONLY = 'RESTORE HEADERONLY FROM DISK=@path;';

/** RESTORE LOG WITH NORECOVERY or STANDBY=@undo, optionally disconnecting readers first. */
export function restoreLog({ standby = false, disconnectUsers = false } = {}) {
    const restore = `RESTORE LOG @db FROM DISK=@path WITH ${standby ? 'STANDBY=@undo' : 'NORECOVERY'}, CHECKSUM;`;
    return disconnectUsers ? `${KILL_SESSIONS}\n${restore}` : restore;
}
