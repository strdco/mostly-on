/*
    Mostly On helper procedures, version 1.

    Mostly On never needs a sysadmin login. Everything that needs high privileges
    (BACKUP, RESTORE, ALTER DATABASE, KILL) happens inside the procedures in the
    [mostly_on] schema of master. They are signed with a certificate whose login
    holds CONTROL SERVER and dbcreator; the login Mostly On uses only gets
    EXECUTE on them, plus read access to server state and backup history.

    The procedures refuse system databases, and only read or write backup files
    under the shared backup folder given below.

    How to run it:
      * As a member of sysadmin, on every SQL Server that Mostly On manages.
      * Create the login Mostly On uses first (CREATE LOGIN ...).
      * Run it again whenever Mostly On says the setup is out of date. Running it
        again is always safe.

    Mostly On's Servers page offers this script with the values below filled in.
    To run the template with sqlcmd instead:
      sqlcmd -S <server> -E -b -i mostly-on-helpers.sql -v ServiceLogin="mostly_on"
             BackupRoot="/var/opt/mssql/backup" StandbyRoot="default" FallbackOwner="sa"
      (StandbyRoot "default" means the server's default data folder.)
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;
USE master;
GO

-- Stops here (every following batch is skipped) if a precondition fails.
IF (IS_SRVROLEMEMBER(N'sysadmin')!=1) BEGIN;
    RAISERROR(N'Run this script as a member of the sysadmin server role.', 16, 1);
    SET NOEXEC ON;
END;
IF (SUSER_ID(N'$(ServiceLogin)') IS NULL) BEGIN;
    RAISERROR(N'The login $(ServiceLogin) does not exist. Create it first (CREATE LOGIN), then run this script again.', 16, 1);
    SET NOEXEC ON;
END;
IF (N'$(BackupRoot)' NOT LIKE N'/%' AND N'$(BackupRoot)' NOT LIKE N'[A-Za-z]:\%' AND N'$(BackupRoot)' NOT LIKE N'\\%') BEGIN;
    RAISERROR(N'BackupRoot must be an absolute path, as this SQL Server sees the shared backup folder.', 16, 1);
    SET NOEXEC ON;
END;
GO

IF (SCHEMA_ID(N'mostly_on') IS NULL) EXEC (N'CREATE SCHEMA mostly_on AUTHORIZATION dbo;');
GO

-- Start clean: dropping the old procedures also removes their signatures, so the
-- previous certificate (and its login) can go.
DECLARE @drop nvarchar(max);

SELECT @drop=STRING_AGG(CAST(N'DROP '+CASE o.type WHEN 'P' THEN N'PROCEDURE' ELSE N'FUNCTION' END+N' mostly_on.'+QUOTENAME(o.name)+N';' AS nvarchar(max)), N'')
FROM sys.objects AS o
WHERE o.schema_id=SCHEMA_ID(N'mostly_on')
  AND o.type IN ('P', 'FN');

IF (@drop IS NOT NULL) EXEC sys.sp_executesql @drop;
IF (SUSER_ID(N'mostly_on_signing') IS NOT NULL) DROP LOGIN mostly_on_signing;
IF (CERT_ID(N'mostly_on_signing') IS NOT NULL) DROP CERTIFICATE mostly_on_signing;
GO

IF (OBJECT_ID(N'mostly_on.settings', N'U') IS NULL)
CREATE TABLE mostly_on.settings (
    id                  tinyint NOT NULL CONSTRAINT DF_settings_id DEFAULT (1),
    backup_root         nvarchar(400) NOT NULL,                  -- the shared backup folder, as this SQL Server sees it
    standby_root        nvarchar(400) NULL,                      -- undo files of readable copies (NULL = default data folder)
    fallback_owner      sysname NOT NULL,                        -- owner of a recovered database when its own owner has no login here
    CONSTRAINT PK_settings PRIMARY KEY CLUSTERED (id),
    CONSTRAINT CK_settings_single_row CHECK (id=1)
);
GO

MERGE mostly_on.settings AS s
USING (VALUES (1, N'$(BackupRoot)', NULLIF(NULLIF(N'$(StandbyRoot)', N''), N'default'), ISNULL(NULLIF(N'$(FallbackOwner)', N''), N'sa'))) AS v (id, backup_root, standby_root, fallback_owner)
ON s.id=v.id
WHEN MATCHED THEN UPDATE SET s.backup_root=v.backup_root, s.standby_root=v.standby_root, s.fallback_owner=v.fallback_owner
WHEN NOT MATCHED THEN INSERT (id, backup_root, standby_root, fallback_owner) VALUES (v.id, v.backup_root, v.standby_root, v.fallback_owner);
GO

-- --- helpers (no privileges of their own) ------------------------------------

CREATE FUNCTION mostly_on.helper_version()
RETURNS int
AS
BEGIN;
    RETURN 2;
END;
GO

-- 1 if @path is under @root (either path separator), else 0.
CREATE FUNCTION mostly_on.is_under(@path nvarchar(400), @root nvarchar(400))
RETURNS bit
AS
BEGIN;
    DECLARE @r nvarchar(400)=@root;
    IF (@path IS NULL OR @r IS NULL OR @r=N'') RETURN 0;
    WHILE (RIGHT(@r, 1) IN (N'/', N'\') AND LEN(@r)>1) SET @r=LEFT(@r, LEN(@r)-1);
    IF (LEFT(@path, LEN(@r))=@r AND SUBSTRING(@path, LEN(@r)+1, 1) IN (N'/', N'\')) RETURN 1;
    RETURN 0;
END;
GO

-- Throws unless @path is a file Mostly On may use: a backup file under the
-- backup root, an undo file of a readable copy, or a database file in this
-- server's default data or log folder.
CREATE PROCEDURE mostly_on.check_path
    @path               nvarchar(400),
    @kind               varchar(10)
AS
SET NOCOUNT ON;
DECLARE @ok bit=0;

IF (@path IS NULL OR CHARINDEX(N'..', @path)>0 OR CHARINDEX(NCHAR(0), @path)>0)
    THROW 50010, N'Mostly On refused a file path: it is empty or contains "..".', 1;

IF (@kind='backup')
    SELECT @ok=mostly_on.is_under(@path, s.backup_root)
    FROM mostly_on.settings AS s
    WHERE RIGHT(@path, 4) IN (N'.bak', N'.trn');

IF (@kind='undo')
    SELECT @ok=mostly_on.is_under(@path, ISNULL(s.standby_root, CONVERT(nvarchar(400), SERVERPROPERTY(N'InstanceDefaultDataPath'))))
    FROM mostly_on.settings AS s
    WHERE RIGHT(@path, 4)=N'.tuf';

IF (@kind='data')
    SET @ok=CASE WHEN mostly_on.is_under(@path, CONVERT(nvarchar(400), SERVERPROPERTY(N'InstanceDefaultDataPath')))=1
                   OR mostly_on.is_under(@path, CONVERT(nvarchar(400), SERVERPROPERTY(N'InstanceDefaultLogPath')))=1 THEN 1 ELSE 0 END;

IF (@ok=0) BEGIN;
    DECLARE @message nvarchar(2048)=N'Mostly On refused the path '+@path+N': it is outside the folders Mostly On may use ('+@kind+N'). '
        +N'If the shared backup folder moved, run the setup script again with the new path.';
    THROW 50011, @message, 1;
END;
GO

-- Throws for system databases, and (with @must_exist=1) for databases that do not exist.
CREATE PROCEDURE mostly_on.check_database
    @db                 sysname,
    @must_exist         bit=1
AS
SET NOCOUNT ON;
IF (@db IS NULL OR @db IN (N'master', N'model', N'msdb', N'tempdb') OR DB_ID(@db) BETWEEN 1 AND 4)
    THROW 50001, N'Mostly On never touches system databases.', 1;
IF (@must_exist=1 AND DB_ID(@db) IS NULL) BEGIN;
    DECLARE @message nvarchar(2048)=N'Database '+@db+N' does not exist on this server.';
    THROW 50002, @message, 1;
END;
GO

-- --- privileged actions (signed) --------------------------------------------------
-- No TRY/CATCH around BACKUP and RESTORE: SQL Server's own error numbers
-- (3101, 3201, 4305, 4326, 4330 ...) must reach Mostly On unchanged.

-- FULL, DIFF or LOG backup, always CHECKSUM + INIT and never compressed (Express).
-- @copy_only makes a FULL that does not affect the backup chain (safety backups).
CREATE PROCEDURE mostly_on.take_backup
    @db                 sysname,
    @type               varchar(4),
    @path               nvarchar(400),
    @name               nvarchar(128),
    @description        nvarchar(255),
    @copy_only          bit=0,
    @continue_after_error bit=0
AS
SET NOCOUNT ON;
EXEC mostly_on.check_database @db=@db;
EXEC mostly_on.check_path @path=@path, @kind='backup';

IF (@type='FULL' AND @copy_only=0)
    BACKUP DATABASE @db TO DISK=@path WITH CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE IF (@type='FULL' AND @copy_only=1 AND @continue_after_error=0)
    BACKUP DATABASE @db TO DISK=@path WITH COPY_ONLY, CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE IF (@type='FULL' AND @copy_only=1 AND @continue_after_error=1)
    BACKUP DATABASE @db TO DISK=@path WITH COPY_ONLY, CONTINUE_AFTER_ERROR, CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE IF (@type='DIFF')
    BACKUP DATABASE @db TO DISK=@path WITH DIFFERENTIAL, CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE IF (@type='LOG')
    BACKUP LOG @db TO DISK=@path WITH CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE
    THROW 50020, N'Unknown backup type.', 1;
GO

-- The tail-log backup of a failover. 'planned': disconnect everyone
-- (SINGLE_USER), then BACKUP LOG WITH NORECOVERY, leaving the old primary
-- waiting to become a secondary. 'forced': best effort on a damaged primary.
CREATE PROCEDURE mostly_on.tail_log
    @db                 sysname,
    @path               nvarchar(400),
    @name               nvarchar(128),
    @description        nvarchar(255),
    @mode               varchar(8),
    @continue_after_error bit=0
AS
SET NOCOUNT ON;
EXEC mostly_on.check_database @db=@db;
EXEC mostly_on.check_path @path=@path, @kind='backup';

IF (@mode='planned') BEGIN;
    DECLARE @sql nvarchar(max)=N'ALTER DATABASE '+QUOTENAME(@db)+N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE;';
    EXEC sys.sp_executesql @sql;
    BACKUP LOG @db TO DISK=@path WITH NORECOVERY, CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
END;
ELSE IF (@mode='forced' AND @continue_after_error=0)
    BACKUP LOG @db TO DISK=@path WITH NO_TRUNCATE, NORECOVERY, CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE IF (@mode='forced' AND @continue_after_error=1)
    BACKUP LOG @db TO DISK=@path WITH NO_TRUNCATE, NORECOVERY, CONTINUE_AFTER_ERROR, CHECKSUM, INIT, NO_COMPRESSION, NAME=@name, DESCRIPTION=@description, STATS=10;
ELSE
    THROW 50021, N'Unknown tail-log mode.', 1;
GO

-- RESTORE DATABASE of a FULL or DIFF, always WITH NORECOVERY. @moves is a JSON
-- array of {"from": logical file name, "to": path}; targets must be in this
-- server's default data or log folder.
CREATE PROCEDURE mostly_on.restore_database
    @db                 sysname,
    @path               nvarchar(400),
    @moves              nvarchar(max)=NULL,
    @replace            bit=0,
    @must_not_exist     bit=0
AS
SET NOCOUNT ON;
EXEC mostly_on.check_database @db=@db, @must_exist=0;

-- A copy restored under a new name never replaces a database that is already there.
IF (@must_not_exist=1 AND DB_ID(@db) IS NOT NULL) BEGIN;
    DECLARE @exists nvarchar(2048)=N'A database named '+@db+N' already exists on this server; choose another name.';
    THROW 50003, @exists, 1;
END;
EXEC mostly_on.check_path @path=@path, @kind='backup';

DECLARE @moves_table TABLE (
    logical_name        sysname NOT NULL,
    physical_name       nvarchar(400) NOT NULL,
    PRIMARY KEY CLUSTERED (logical_name)
);

INSERT INTO @moves_table (logical_name, physical_name)
SELECT m.logical_name, m.physical_name
FROM OPENJSON(ISNULL(@moves, N'[]')) WITH (logical_name sysname N'$.from', physical_name nvarchar(400) N'$.to') AS m;

DECLARE @target nvarchar(400);
DECLARE targets CURSOR LOCAL FAST_FORWARD FOR SELECT m.physical_name FROM @moves_table AS m;
OPEN targets;
FETCH NEXT FROM targets INTO @target;
WHILE (@@FETCH_STATUS=0) BEGIN;
    EXEC mostly_on.check_path @path=@target, @kind='data';
    FETCH NEXT FROM targets INTO @target;
END;
CLOSE targets;
DEALLOCATE targets;

-- Overwriting a database (a rollback of a readable copy): its readers go first.
IF (@replace=1) BEGIN;
    DECLARE @kill nvarchar(max);

    SELECT @kill=STRING_AGG(CAST(N'KILL '+CONVERT(nvarchar(11), s.session_id)+N';' AS nvarchar(max)), N'')
    FROM sys.dm_exec_sessions AS s
    WHERE s.database_id=DB_ID(@db)
      AND s.session_id!=@@SPID;

    IF (@kill IS NOT NULL) EXEC sys.sp_executesql @kill;
END;

-- MOVE clauses as escaped N'...' literals; @db and @path stay parameters.
DECLARE @move nvarchar(max);

SELECT @move=STRING_AGG(CAST(N', MOVE N'''+REPLACE(m.logical_name, N'''', N'''''')+N''' TO N'''+REPLACE(m.physical_name, N'''', N'''''')+N'''' AS nvarchar(max)), N'')
FROM @moves_table AS m;

DECLARE @sql nvarchar(max)=N'RESTORE DATABASE @db FROM DISK=@path WITH NORECOVERY, CHECKSUM, STATS=10'
    +CASE WHEN @replace=1 THEN N', REPLACE' ELSE N'' END
    +ISNULL(@move, N'')+N';';

EXEC sys.sp_executesql @sql, N'@db sysname, @path nvarchar(400)', @db=@db, @path=@path;
GO

-- RESTORE LOG WITH NORECOVERY, or STANDBY (readable copy) when @undo is given.
-- Anyone using a readable copy is disconnected first.
-- @stop_at (point-in-time restore, always NORECOVERY): stop at that moment, in
-- the local time of the server that wrote the log. STOPAT takes a string, not
-- a datetime2 variable.
CREATE PROCEDURE mostly_on.restore_log
    @db                 sysname,
    @path               nvarchar(400),
    @undo               nvarchar(400)=NULL,
    @stop_at            datetime2(3)=NULL
AS
SET NOCOUNT ON;
EXEC mostly_on.check_database @db=@db;
EXEC mostly_on.check_path @path=@path, @kind='backup';
IF (@undo IS NOT NULL) EXEC mostly_on.check_path @path=@undo, @kind='undo';
IF (@undo IS NOT NULL AND @stop_at IS NOT NULL)
    THROW 50004, N'A point-in-time restore cannot leave a readable (STANDBY) copy.', 1;

DECLARE @kill nvarchar(max);

SELECT @kill=STRING_AGG(CAST(N'KILL '+CONVERT(nvarchar(11), s.session_id)+N';' AS nvarchar(max)), N'')
FROM sys.dm_exec_sessions AS s
WHERE s.database_id=DB_ID(@db)
  AND s.session_id!=@@SPID;

IF (@kill IS NOT NULL) EXEC sys.sp_executesql @kill;

DECLARE @stop nvarchar(30)=CONVERT(nvarchar(30), @stop_at, 126);

IF (@stop IS NOT NULL)
    RESTORE LOG @db FROM DISK=@path WITH NORECOVERY, STOPAT=@stop, CHECKSUM;
ELSE IF (@undo IS NULL)
    RESTORE LOG @db FROM DISK=@path WITH NORECOVERY, CHECKSUM;
ELSE
    RESTORE LOG @db FROM DISK=@path WITH STANDBY=@undo, CHECKSUM;
GO

-- Brings a copy online at failover: RESTORE WITH RECOVERY (if it is still
-- restoring), MULTI_USER, then the owner. The owner is the database's own owner
-- if that login exists here (matched by SID, then by name), else the fallback
-- owner. A database created by RESTORE is otherwise owned by the login that
-- ran it, i.e. Mostly On's. Returns the owner and how it was chosen.
CREATE PROCEDURE mostly_on.recover
    @db                 sysname,
    @owner_sid          varbinary(85)=NULL,
    @owner_name         sysname=NULL
AS
SET NOCOUNT ON;
EXEC mostly_on.check_database @db=@db;
DECLARE @sql nvarchar(max);

IF ((SELECT d.state_desc FROM sys.databases AS d WHERE d.name=@db)=N'RESTORING')
    RESTORE DATABASE @db WITH RECOVERY;

IF ((SELECT d.user_access_desc FROM sys.databases AS d WHERE d.name=@db)!=N'MULTI_USER') BEGIN;
    SET @sql=N'ALTER DATABASE '+QUOTENAME(@db)+N' SET MULTI_USER;';
    EXEC sys.sp_executesql @sql;
END;

DECLARE @owner sysname, @matched_by varchar(10), @note nvarchar(2048);

-- Individual logins only: a Windows group cannot own a database.
SELECT @owner=sp.name, @matched_by='sid'
FROM sys.server_principals AS sp
WHERE sp.sid=@owner_sid
  AND sp.type IN ('S', 'U', 'E');

IF (@owner IS NULL)
    SELECT @owner=sp.name, @matched_by='name'
    FROM sys.server_principals AS sp
    WHERE sp.name=@owner_name
      AND sp.type IN ('S', 'U', 'E');

IF (@owner IS NULL)
    SELECT @owner=s.fallback_owner, @matched_by='fallback'
    FROM mostly_on.settings AS s;

BEGIN TRY;
    SET @sql=N'ALTER AUTHORIZATION ON DATABASE::'+QUOTENAME(@db)+N' TO '+QUOTENAME(@owner)+N';';
    EXEC sys.sp_executesql @sql;
END TRY
BEGIN CATCH;
    -- The database is online either way; the owner is reported, not fatal.
    SET @note=ERROR_MESSAGE();
    SELECT @owner=SUSER_SNAME(d.owner_sid), @matched_by='failed'
    FROM sys.databases AS d
    WHERE d.name=@db;
END CATCH;

SELECT @owner AS owner_name, @matched_by AS matched_by, @note AS note;
GO

-- OFFLINE (no one can write to an out-of-sync copy), ONLINE_RESTRICTED (for a
-- safety backup of an offline copy) or MULTI_USER.
CREATE PROCEDURE mostly_on.set_state
    @db                 sysname,
    @state              varchar(20)
AS
SET NOCOUNT ON;
EXEC mostly_on.check_database @db=@db;
DECLARE @sql nvarchar(max)=CASE @state
    WHEN 'OFFLINE' THEN N'ALTER DATABASE '+QUOTENAME(@db)+N' SET OFFLINE WITH ROLLBACK IMMEDIATE;'
    WHEN 'ONLINE_RESTRICTED' THEN N'ALTER DATABASE '+QUOTENAME(@db)+N' SET ONLINE; ALTER DATABASE '+QUOTENAME(@db)+N' SET RESTRICTED_USER WITH ROLLBACK IMMEDIATE;'
    WHEN 'MULTI_USER' THEN N'ALTER DATABASE '+QUOTENAME(@db)+N' SET MULTI_USER;'
    END;
IF (@sql IS NULL) THROW 50030, N'Unknown database state.', 1;
EXEC sys.sp_executesql @sql;
GO

CREATE PROCEDURE mostly_on.header_only
    @path               nvarchar(400)
AS
SET NOCOUNT ON;
EXEC mostly_on.check_path @path=@path, @kind='backup';
RESTORE HEADERONLY FROM DISK=@path;
GO

CREATE PROCEDURE mostly_on.filelist_only
    @path               nvarchar(400)
AS
SET NOCOUNT ON;
EXEC mostly_on.check_path @path=@path, @kind='backup';
RESTORE FILELISTONLY FROM DISK=@path;
GO

-- Optional msdb cleanup (SQL Server Agent would normally do this).
CREATE PROCEDURE mostly_on.purge_backup_history
    @keep_days          int
AS
SET NOCOUNT ON;
IF (@keep_days IS NULL OR @keep_days<1) THROW 50040, N'Keep at least one day of backup history.', 1;
DECLARE @oldest datetime2(0)=DATEADD(day, -@keep_days, GETDATE());
EXEC msdb.dbo.sp_delete_backuphistory @oldest_date=@oldest;
GO

-- --- signing ------------------------------------------------------------------
-- A new certificate signs every procedure; its private key is then removed, so
-- nothing else can ever be signed with it.

DECLARE @password nvarchar(128)=CONVERT(nvarchar(36), NEWID())+N'-Mo!'+CONVERT(nvarchar(36), NEWID());
DECLARE @sql nvarchar(max)=N'CREATE CERTIFICATE mostly_on_signing ENCRYPTION BY PASSWORD='+QUOTENAME(@password, N'''')
    +N' WITH SUBJECT=N''Mostly On helper procedures'', EXPIRY_DATE=''2099-12-31'';';
EXEC sys.sp_executesql @sql;

SELECT @sql=STRING_AGG(CAST(N'ADD SIGNATURE TO mostly_on.'+QUOTENAME(p.name)+N' BY CERTIFICATE mostly_on_signing WITH PASSWORD='+QUOTENAME(@password, N'''')+N';' AS nvarchar(max)), N'')
FROM sys.procedures AS p
WHERE p.schema_id=SCHEMA_ID(N'mostly_on');
EXEC sys.sp_executesql @sql;

CREATE LOGIN mostly_on_signing FROM CERTIFICATE mostly_on_signing;
GRANT CONTROL SERVER TO mostly_on_signing;
-- RESTORE onto an existing database checks dbcreator membership, not a permission.
ALTER SERVER ROLE dbcreator ADD MEMBER mostly_on_signing;
ALTER CERTIFICATE mostly_on_signing REMOVE PRIVATE KEY;
GO

-- --- Mostly On's own login ------------------------------------------------------------
-- EXECUTE on the procedures, plus read access for health checks and backup history.

DECLARE @login sysname=N'$(ServiceLogin)';
DECLARE @sql nvarchar(max);

IF (IS_SRVROLEMEMBER(N'sysadmin', @login)=0) BEGIN;
    SET @sql=CASE WHEN USER_ID(@login) IS NULL THEN N'CREATE USER '+QUOTENAME(@login)+N' FOR LOGIN '+QUOTENAME(@login)+N'; ' ELSE N'' END
        +N'GRANT EXECUTE ON SCHEMA::mostly_on TO '+QUOTENAME(@login)+N'; '
        +N'GRANT VIEW SERVER STATE TO '+QUOTENAME(@login)+N'; '
        +N'GRANT VIEW ANY DEFINITION TO '+QUOTENAME(@login)+N';';
    EXEC sys.sp_executesql @sql;

    SET @sql=CASE WHEN (SELECT COUNT(*) FROM msdb.sys.database_principals AS dp WHERE dp.name=@login)=0
                  THEN N'CREATE USER '+QUOTENAME(@login)+N' FOR LOGIN '+QUOTENAME(@login)+N'; ' ELSE N'' END
        +N'ALTER ROLE db_datareader ADD MEMBER '+QUOTENAME(@login)+N';';
    EXEC msdb.sys.sp_executesql @sql;
END;
GO

USE master;
SELECT N'Mostly On helper procedures version '+CONVERT(nvarchar(11), mostly_on.helper_version())+N' are installed for $(ServiceLogin).' AS result;
GO
SET NOEXEC OFF;
GO
