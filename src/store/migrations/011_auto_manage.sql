-- Automatic management (engine/auto-manage.js).
-- auto_manage: Mostly-On manages the user databases on this server by itself,
-- and stops managing one that is dropped. ship_to_server_id: the server new
-- databases in FULL recovery are log shipped to (NULL = no secondary).
ALTER TABLE servers ADD COLUMN auto_manage integer NOT NULL DEFAULT 0;
ALTER TABLE servers ADD COLUMN ship_to_server_id integer NULL REFERENCES servers (id) ON DELETE SET NULL;

-- Why a database is no longer managed: 'person' (Stop managing), or 'dropped'
-- (gone from its server; retention then removes its backups in time).
-- auto_seed: managed automatically, and still to get a secondary on the
-- default target of its primary.
ALTER TABLE databases ADD COLUMN stopped_by text NULL CHECK (stopped_by IN ('person', 'dropped'));
ALTER TABLE databases ADD COLUMN auto_seed integer NOT NULL DEFAULT 0;

-- Databases stopped before this version were stopped by a person: automatic
-- management leaves them alone.
UPDATE databases SET stopped_by='person' WHERE status='unmanaged';
