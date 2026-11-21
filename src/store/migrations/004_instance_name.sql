-- Named SQL Server instances (for example SQLEXPRESS), reached through the
-- SQL Server Browser service instead of a fixed port. NULL = host:port.
ALTER TABLE servers ADD COLUMN instance_name text NULL;
