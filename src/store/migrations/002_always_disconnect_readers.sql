-- Readers of a STANDBY secondary are now always disconnected before a log
-- restore (user decision 2026-11-21), so the per-replica choice is gone.
ALTER TABLE database_replicas DROP COLUMN disconnect_users;
