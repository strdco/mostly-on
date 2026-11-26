-- A database's schedules follow the default schedules in Settings, until
-- someone edits one on the database's page; that one is then its own.
-- follows_default=1: the row is a copy of the default and changes with it
-- (store/repos/schedules.js applyDefaults, run at start and when a default is saved).
ALTER TABLE schedules ADD COLUMN follows_default integer NOT NULL DEFAULT 1;

-- Until now each database got a copy of the defaults when it started being
-- managed, and kept it. The ones someone edited since (the "... schedule of
-- <name> changed" event, after the database was last managed: managing again
-- reset its schedules to the defaults) keep their own schedule.
UPDATE schedules SET follows_default=0
WHERE EXISTS (
    SELECT 1 FROM events AS e
    WHERE e.category='schedule' AND e.database_id=schedules.database_id
      AND e.message LIKE schedules.backup_type || ' schedule of % changed'
      AND e.id > COALESCE((
          SELECT MAX(m.id) FROM events AS m
          WHERE m.category='database' AND m.database_id=schedules.database_id
            AND (m.message LIKE 'Started managing %' OR m.message LIKE 'Started backing up %')
      ), 0)
);

-- FULL and LOG defaults are always on: a switched-off one was switched off on purpose.
UPDATE schedules SET follows_default=0 WHERE backup_type!='DIFF' AND enabled=0;
