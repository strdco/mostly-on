// Every read-only T-SQL statement the controller sends lives in this file.
// Privileged actions (BACKUP, RESTORE, ALTER DATABASE, KILL) are calls to the
// signed helper procedures: see privileged.js and sql/mostly-on-helpers.sql.
//
// Rules:
//  * Values (database names, paths, LSNs) are always @parameters.
//  * These run as Mostly-On's own login, which only has read access
//    (VIEW SERVER STATE, VIEW ANY DEFINITION, msdb db_datareader).
//  * LSN columns are CAST to varchar(25) because the driver would otherwise
//    turn numeric(25,0) into a lossy JS number.
//  * msdb datetimes are server-local; they are converted to UTC datetime2 here.

// Converts a server-local datetime column to UTC datetime2(3).
const utc = (col) => `CONVERT(datetime2(3), SWITCHOFFSET(TODATETIMEOFFSET(${col}, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())), 0))`;

// Also where it runs: the host (sys.dm_os_host_info) and whether that is a
// container (sys.dm_os_sys_info.container_type_desc: NONE, LINUX CONTAINER ...).
// Read through sp_executesql, so an older version without them still answers.
export const SERVER_INFO = `
SET NOCOUNT ON;
DECLARE @platform nvarchar(256)=NULL, @distribution nvarchar(256)=NULL, @release nvarchar(256)=NULL, @container nvarchar(60)=NULL;
IF (OBJECT_ID(N'sys.dm_os_host_info') IS NOT NULL)
    EXEC sys.sp_executesql N'SELECT @p=h.host_platform, @d=h.host_distribution, @r=h.host_release FROM sys.dm_os_host_info AS h;',
        N'@p nvarchar(256) OUTPUT, @d nvarchar(256) OUTPUT, @r nvarchar(256) OUTPUT', @p=@platform OUTPUT, @d=@distribution OUTPUT, @r=@release OUTPUT;
IF (COL_LENGTH(N'sys.dm_os_sys_info', N'container_type_desc') IS NOT NULL)
    EXEC sys.sp_executesql N'SELECT @c=i.container_type_desc FROM sys.dm_os_sys_info AS i;', N'@c nvarchar(60) OUTPUT', @c=@container OUTPUT;

SELECT CONVERT(nvarchar(128), SERVERPROPERTY(N'ProductVersion')) AS product_version,
       CONVERT(nvarchar(128), SERVERPROPERTY(N'Edition')) AS edition,
       CONVERT(int, SERVERPROPERTY(N'EngineEdition')) AS engine_edition,
       CONVERT(nvarchar(260), SERVERPROPERTY(N'InstanceDefaultDataPath')) AS default_data_path,
       CONVERT(nvarchar(260), SERVERPROPERTY(N'InstanceDefaultLogPath')) AS default_log_path,
       CONVERT(nvarchar(128), @@SERVERNAME) AS server_name,
       SYSUTCDATETIME() AS utc_now,
       DATEPART(TZOFFSET, SYSDATETIMEOFFSET()) AS tz_offset_minutes,
       @platform AS host_platform,
       @distribution AS host_distribution,
       @release AS host_release,
       @container AS container_type;`;

// The files of a database as they are on this server (for RESTORE ... REPLACE in place).
export const DB_FILES = `
SELECT mf.name AS logical_name, mf.physical_name, mf.type_desc
FROM sys.master_files AS mf
WHERE mf.database_id=DB_ID(@db);`;

// One row per database (the system databases too, but never tempdb or a
// database snapshot) with everything the health/shipping logic needs.
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
WHERE d.database_id!=2
  AND d.source_database_id IS NULL
ORDER BY d.name;`;

export { utc };

// --- backup engine ----------------------------------------------------------

// Fresh state of one database on its primary, right before a backup.
// differential_base_* identify the FULL a DIFF taken now would be based on.
export const DB_BACKUP_STATE = `
SELECT d.name,
       d.database_id,
       d.source_database_id,
       d.state_desc,
       d.recovery_model_desc,
       d.is_read_only,
       CONVERT(char(36), drs.family_guid) AS family_guid,
       CONVERT(char(36), drs.recovery_fork_guid) AS recovery_fork_guid,
       CAST(drs.last_log_backup_lsn AS varchar(25)) AS last_log_backup_lsn,
       CAST(mf.differential_base_lsn AS varchar(25)) AS differential_base_lsn,
       CONVERT(char(36), mf.differential_base_guid) AS differential_base_guid,
       CONVERT(varchar(172), d.owner_sid, 1) AS owner_sid,
       SUSER_SNAME(d.owner_sid) AS owner_name,
       CONVERT(varchar(172), SUSER_SID(), 1) AS service_login_sid
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id=d.database_id
LEFT JOIN sys.master_files AS mf ON mf.database_id=d.database_id AND mf.file_id=1
WHERE d.name=@db;`;

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

// Is the server ready for Mostly-On? Helper procedure version (NULL if they
// are missing), whether they are all still signed, and the permissions the
// login needs, and the folders the setup script was last run with. Runs as the
// login Mostly-On uses.
export const HELPER_STATUS = `
DECLARE @version int=NULL, @setup nvarchar(max)=NULL;
IF (OBJECT_ID(N'master.mostly_on.helper_version', N'FN') IS NOT NULL)
    EXEC sys.sp_executesql N'SELECT @v=master.mostly_on.helper_version();', N'@v int OUTPUT', @v=@version OUTPUT;
IF (OBJECT_ID(N'master.mostly_on.setup_values', N'FN') IS NOT NULL)
    EXEC sys.sp_executesql N'SELECT @s=master.mostly_on.setup_values();', N'@s nvarchar(max) OUTPUT', @s=@setup OUTPUT;

SELECT @version AS helper_version,
       JSON_VALUE(@setup, N'$.backup_root') AS setup_backup_root,
       JSON_VALUE(@setup, N'$.standby_root') AS setup_standby_root,
       (SELECT COUNT(*) FROM master.sys.procedures AS p WHERE p.schema_id=SCHEMA_ID(N'mostly_on')) AS procedures,
       (SELECT COUNT(*)
        FROM master.sys.procedures AS p
        INNER JOIN master.sys.crypt_properties AS cp ON cp.major_id=p.object_id
        WHERE p.schema_id=SCHEMA_ID(N'mostly_on')) AS signed_procedures,
       HAS_PERMS_BY_NAME(N'master.mostly_on.take_backup', N'OBJECT', N'EXECUTE') AS can_execute,
       HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') AS view_server_state,
       HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW ANY DEFINITION') AS view_any_definition,
       HAS_PERMS_BY_NAME(N'msdb.dbo.backupset', N'OBJECT', N'SELECT') AS read_msdb,
       IS_SRVROLEMEMBER(N'sysadmin') AS is_sysadmin,
       SUSER_SNAME() AS login_name;`;
