-- Backups-only databases: system databases (master, model, msdb) and user
-- databases not in FULL recovery. They are backed up on their own server and
-- never shipped or restored, so each belongs to one server (every server has
-- its own master). A name stays unique among log-shipped databases, and per
-- server among backups-only ones.
-- SQLite cannot drop a UNIQUE constraint, so the table is rebuilt (the runner
-- turns foreign keys off, so rows that refer to it stay).
CREATE TABLE databases_new (
    id                      integer PRIMARY KEY,
    name                    text NOT NULL,
    family_guid             text NULL,
    status                  text NOT NULL DEFAULT 'managed' CHECK (status IN ('managed', 'unmanaged')),
    created_at              text NOT NULL,
    updated_at              text NOT NULL,
    owner_sid               text NULL,
    owner_name              text NULL,
    owner_fallback          text NULL,
    retention_full_days     integer NULL,
    retention_diff_days     integer NULL,
    retention_log_days      integer NULL,
    backup_only_server_id   integer NULL REFERENCES servers (id)    -- NULL = log shipped; else backups only, on this server
) STRICT;

INSERT INTO databases_new (id, name, family_guid, status, created_at, updated_at, owner_sid, owner_name, owner_fallback,
                           retention_full_days, retention_diff_days, retention_log_days)
SELECT id, name, family_guid, status, created_at, updated_at, owner_sid, owner_name, owner_fallback,
       retention_full_days, retention_diff_days, retention_log_days
FROM databases;

DROP TABLE databases;
ALTER TABLE databases_new RENAME TO databases;

CREATE UNIQUE INDEX databases_shipped_name ON databases (name) WHERE backup_only_server_id IS NULL;
CREATE UNIQUE INDEX databases_backup_only_name ON databases (name, backup_only_server_id) WHERE backup_only_server_id IS NOT NULL;
