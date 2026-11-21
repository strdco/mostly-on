-- Per-database backup retention (days). NULL = use the global setting.
ALTER TABLE databases ADD COLUMN retention_full_days integer NULL;
ALTER TABLE databases ADD COLUMN retention_diff_days integer NULL;
ALTER TABLE databases ADD COLUMN retention_log_days integer NULL;
