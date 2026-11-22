-- A secondary can be kept deliberately behind the primary (restore delay): it
-- only restores a log backup once that backup is this many minutes old, so
-- older data can be looked at. A delayed secondary is never a failover target.
-- The upper limit is checked by the API, so it can change without a rebuild.
ALTER TABLE database_replicas ADD COLUMN restore_delay_minutes integer NOT NULL DEFAULT 0 CHECK (restore_delay_minutes >= 0);
-- Restores of a delayed secondary can be paused while someone investigates on it.
--   NULL      normal
--   future    paused until then
--   past      catching up after a pause or a lowered delay (no lag alert); the
--             restore loop clears it once the copy is back where its delay says
ALTER TABLE database_replicas ADD COLUMN restores_paused_until text NULL;
