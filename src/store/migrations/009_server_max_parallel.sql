-- Backups and restores at a time on this SQL Server instance. NULL = the
-- orchestrator's default (setting servers.max_parallel). Health checks and
-- other short queries have their own connections and do not count.
ALTER TABLE servers ADD COLUMN max_parallel integer NULL;
