-- The STANDBY undo file a readable secondary uses now (a SQL Server path).
-- SQL Server lets a login that is not sysadmin reuse a copy's current undo
-- file or create a new one, but not overwrite a file an earlier copy left
-- behind (error 3441, OS error 1244), and nothing inside SQL Server can delete
-- it. So whenever a readable copy starts over (added, reinitialized, rolled
-- back, switched to readable) it gets a new undo file, remembered here.
ALTER TABLE database_replicas ADD COLUMN standby_undo_file text NULL;
