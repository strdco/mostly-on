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
       files.data_bytes,
       files.log_bytes,
       CAST(files.redo_start_lsn AS varchar(25)) AS redo_start_lsn,
       files.redo_start_fork_guid
FROM sys.databases AS d
LEFT JOIN sys.database_recovery_status AS drs ON drs.database_id=d.database_id
OUTER APPLY (
    SELECT SUM(CASE WHEN mf.type=0 THEN CAST(mf.size AS bigint) END)*8192 AS data_bytes,
           SUM(CASE WHEN mf.type=1 THEN CAST(mf.size AS bigint) END)*8192 AS log_bytes,
           MIN(CASE WHEN mf.type=0 THEN mf.redo_start_lsn END) AS redo_start_lsn,
           MIN(CASE WHEN mf.type=0 AND mf.file_id=1 THEN CONVERT(char(36), mf.redo_start_fork_guid) END) AS redo_start_fork_guid
    FROM sys.master_files AS mf
    WHERE mf.database_id=d.database_id
    ) AS files
WHERE d.database_id>4
ORDER BY d.name;`;

export { utc };
