-- Named user accounts, and who started what.
-- Users are never deleted, only disabled, so every name in the audit trail
-- (events.actor, operations.created_by) still means one account.
-- must_change_password: set when someone else chose the password (a new
-- account, or a reset); the user picks their own at the next login.
CREATE TABLE users (
    id                      integer PRIMARY KEY,
    username                text NOT NULL COLLATE NOCASE UNIQUE,
    password_hash           text NOT NULL,
    must_change_password    integer NOT NULL DEFAULT 0,
    created_at              text NOT NULL,
    created_by              text NULL,
    disabled_at             text NULL,
    last_login_at           text NULL
) STRICT;

-- The user who did it; NULL = Mostly-On itself (schedules, log shipping, ...).
ALTER TABLE events ADD COLUMN actor text NULL;
CREATE INDEX events_actor ON events (actor, id) WHERE actor IS NOT NULL;

ALTER TABLE operations ADD COLUMN created_by text NULL;
