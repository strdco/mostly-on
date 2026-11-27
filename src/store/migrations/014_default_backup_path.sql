-- The server's own default backup folder (SERVERPROPERTY InstanceDefaultBackupPath),
-- from the last health check. Shown on the server's page only: Mostly-On always
-- backs up to the shared backup folder (sql_backup_root), which may differ.
ALTER TABLE servers ADD COLUMN default_backup_path text NULL;
