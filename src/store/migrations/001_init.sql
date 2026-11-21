-- Mostly-On catalog, version 1.
-- Conventions: timestamps are ISO-8601 UTC text, LSNs are decimal text
-- (compared as BigInt in code, never as numbers), booleans are 0/1 integers,
-- JSON is stored as text.

CREATE TABLE servers (
    id                      integer PRIMARY KEY,
    name                    text NOT NULL UNIQUE,            -- also used in backup file names
    host                    text NOT NULL,
    port                    integer NOT NULL DEFAULT 1433,
    username                text NOT NULL,
    password_enc            text NOT NULL,                   -- AES-256-GCM with SECRET_KEY
    encrypt                 integer NOT NULL DEFAULT 1,
    trust_server_cert       integer NOT NULL DEFAULT 0,
    sql_backup_root         text NOT NULL,                   -- shared root as SQL Server sees it
    controller_backup_root  text NULL,                       -- shared root as the controller sees it (NULL = BACKUP_ROOT)
    standby_root            text NULL,                       -- where STANDBY undo files go (SQL Server path)
    enabled                 integer NOT NULL DEFAULT 1,
    last_seen_at            text NULL,
    last_error              text NULL,
    product_version         text NULL,
    edition                 text NULL,
    engine_edition          integer NULL,
    default_data_path       text NULL,
    default_log_path        text NULL,
    created_at              text NOT NULL,
    updated_at              text NOT NULL
) STRICT;

CREATE TABLE databases (
    id                      integer PRIMARY KEY,
    name                    text NOT NULL UNIQUE,
    family_guid             text NULL,
    status                  text NOT NULL DEFAULT 'managed' CHECK (status IN ('managed', 'unmanaged')),
    created_at              text NOT NULL,
    updated_at              text NOT NULL
) STRICT;

CREATE TABLE discovered_databases (
    server_id               integer NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
    name                    text NOT NULL,
    recovery_model          text NULL,
    state                   text NULL,
    has_log_chain           integer NULL,                    -- 0 = FULL recovery but no full backup yet (pseudo-simple)
    first_seen_at           text NOT NULL,
    last_seen_at            text NOT NULL,
    dismissed_at            text NULL,
    PRIMARY KEY (server_id, name)
) STRICT;

CREATE TABLE database_replicas (
    database_id             integer NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
    server_id               integer NOT NULL REFERENCES servers (id),
    role                    text NOT NULL CHECK (role IN ('primary', 'secondary', 'diverged')),
    chain_state             text NOT NULL DEFAULT 'ok' CHECK (chain_state IN ('seeding', 'ok', 'broken', 'needs_reseed')),
    chain_reason            text NULL,
    restore_mode            text NOT NULL DEFAULT 'norecovery' CHECK (restore_mode IN ('norecovery', 'standby')),
    disconnect_users        integer NOT NULL DEFAULT 0,      -- STANDBY only: kick readers before each restore
    position_lsn            text NULL,                       -- next LSN this secondary needs (redo start)
    position_fork_guid      text NULL,
    last_restored_file_id   integer NULL REFERENCES backup_files (id),
    last_restored_at        text NULL,
    updated_at              text NOT NULL,
    PRIMARY KEY (database_id, server_id)
) STRICT;

CREATE UNIQUE INDEX one_primary ON database_replicas (database_id) WHERE role='primary';

CREATE TABLE forks (
    database_id             integer NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
    fork_guid               text NOT NULL,
    parent_fork_guid        text NULL,
    fork_point_lsn          text NULL,                       -- NULL for the root fork
    created_by_operation_id integer NULL,
    created_at              text NOT NULL,
    PRIMARY KEY (database_id, fork_guid)
) STRICT;

CREATE TABLE backup_files (
    id                      integer PRIMARY KEY,
    database_id             integer NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
    server_id               integer NOT NULL REFERENCES servers (id),
    type                    text NOT NULL CHECK (type IN ('FULL', 'DIFF', 'LOG', 'DIVERGED')),
    rel_path                text NOT NULL UNIQUE,            -- relative to the shared backup root
    first_lsn               text NULL,
    last_lsn                text NULL,
    checkpoint_lsn          text NULL,
    database_backup_lsn     text NULL,
    differential_base_lsn   text NULL,
    differential_base_guid  text NULL,
    family_guid             text NULL,
    recovery_fork_guid      text NULL,
    first_recovery_fork_guid text NULL,
    fork_point_lsn          text NULL,
    backup_set_uuid         text NULL,
    backup_start            text NULL,
    backup_finish           text NULL,
    size_bytes              integer NULL,
    has_checksum            integer NOT NULL DEFAULT 0,
    is_tail                 integer NOT NULL DEFAULT 0,
    is_copy_only            integer NOT NULL DEFAULT 0,
    file_status             text NOT NULL DEFAULT 'present' CHECK (file_status IN ('present', 'missing', 'deleted')),
    deleted_at              text NULL,
    operation_id            integer NULL,
    created_at              text NOT NULL
) STRICT;

CREATE INDEX backup_files_db_type ON backup_files (database_id, type, backup_finish);

CREATE TABLE restores (
    id                      integer PRIMARY KEY,
    backup_file_id          integer NOT NULL REFERENCES backup_files (id) ON DELETE CASCADE,
    database_id             integer NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
    server_id               integer NOT NULL REFERENCES servers (id),
    started_at              text NOT NULL,
    finished_at             text NULL,
    outcome                 text NULL CHECK (outcome IN ('running', 'success', 'failed', 'already_applied', 'interrupted')),
    error                   text NULL,
    operation_id            integer NULL
) STRICT;

CREATE INDEX restores_target ON restores (database_id, server_id, started_at);

CREATE TABLE operations (
    id                      integer PRIMARY KEY,
    type                    text NOT NULL,
    database_id             integer NULL REFERENCES databases (id) ON DELETE SET NULL,
    server_id               integer NULL REFERENCES servers (id),
    parent_id               integer NULL REFERENCES operations (id),
    params                  text NOT NULL DEFAULT '{}',
    status                  text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'resolved')),
    current_step            text NULL,
    steps                   text NOT NULL DEFAULT '[]',
    ctx                     text NOT NULL DEFAULT '{}',
    error                   text NULL,
    created_at              text NOT NULL,
    updated_at              text NOT NULL,
    finished_at             text NULL
) STRICT;

CREATE INDEX operations_status ON operations (status, created_at);

CREATE TABLE events (
    id                      integer PRIMARY KEY,
    ts                      text NOT NULL,
    level                   text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    category                text NOT NULL,
    database_id             integer NULL,
    server_id               integer NULL,
    operation_id            integer NULL,
    message                 text NOT NULL,
    data                    text NULL
) STRICT;

CREATE INDEX events_ts ON events (ts);
CREATE INDEX events_database ON events (database_id, ts);

CREATE TABLE schedules (
    database_id             integer NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
    backup_type             text NOT NULL CHECK (backup_type IN ('FULL', 'DIFF', 'LOG')),
    enabled                 integer NOT NULL DEFAULT 1,
    kind                    text NOT NULL CHECK (kind IN ('interval', 'daily', 'weekly')),
    interval_minutes        integer NULL,
    at_time                 text NULL,                       -- HH:MM, controller local time (TZ)
    weekday                 integer NULL,                    -- 0 = Sunday
    next_run_at             text NULL,
    last_run_at             text NULL,
    last_status             text NULL,
    PRIMARY KEY (database_id, backup_type)
) STRICT;

CREATE TABLE foreign_backups (
    backup_set_uuid         text PRIMARY KEY,
    database_id             integer NOT NULL REFERENCES databases (id) ON DELETE CASCADE,
    server_id               integer NOT NULL REFERENCES servers (id),
    type                    text NOT NULL,
    finish_at               text NULL,
    device                  text NULL,
    detected_at             text NOT NULL,
    acknowledged_at         text NULL
) STRICT;

CREATE TABLE settings (
    key                     text PRIMARY KEY,
    value                   text NOT NULL
) STRICT;

CREATE TABLE notification_state (
    key                     text PRIMARY KEY,                -- stable condition key, e.g. lag:7:2
    kind                    text NOT NULL,
    severity                text NOT NULL,
    status                  text NOT NULL CHECK (status IN ('active', 'resolved')),
    message                 text NOT NULL,
    first_seen_at           text NOT NULL,
    last_notified_at        text NULL,
    resolved_at             text NULL,
    database_id             integer NULL,
    server_id               integer NULL
) STRICT;

CREATE TABLE sessions (
    id_hash                 text PRIMARY KEY,                -- sha256 of the cookie value
    username                text NOT NULL,
    csrf_token              text NOT NULL,
    created_at              text NOT NULL,
    expires_at              text NOT NULL,
    last_seen_at            text NOT NULL
) STRICT;
