-- "Remove" on a server that has history (backups, restores, operations) keeps
-- its row: the backup files it wrote are found through it. A removed server is
-- hidden everywhere and never contacted; registering its name again brings the
-- row back with the new details.
ALTER TABLE servers ADD COLUMN removed_at text NULL;
