-- The owner of each managed database (from its primary), so a failover can give
-- the recovered copy the same owner instead of Mostly On's own login.
ALTER TABLE databases ADD COLUMN owner_sid text NULL;        -- '0x...' as SQL Server reports it
ALTER TABLE databases ADD COLUMN owner_name text NULL;       -- login name on the primary
ALTER TABLE databases ADD COLUMN owner_fallback text NULL;   -- login that stood in after a failover fell back (not a real owner change)
