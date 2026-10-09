-- WP5 §S5-3 follow-up — one archive per file name (the second half of the
-- duplicate-backup fix; scripts/backup.sh is the first).
--
-- A file name identifies exactly one archive. Before this, `filename` had only a
-- non-unique index, so two backups that picked the same name (a real possibility
-- when the name ended at whole seconds) produced two rows pointing at one file:
-- the survivor overwrote the other, and the overwritten row then failed every
-- later verification with a size or checksum mismatch.
--
-- The script now refuses to reuse an existing name, so a collision should never
-- reach the database. This unique index is the floor under that: even a bug, a
-- second machine writing into the same directory, or two concurrent
-- `syncBackupsFromDisk` scans cannot record two rows for one file.
--
-- The index replaces the non-unique lookup index of the same column, so filename
-- lookups keep their index. It fails loudly on a database that already holds
-- duplicate names, which is the correct signal to resolve them by hand rather
-- than let a constraint be silently skipped.
DROP INDEX "backup_history_filename_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "backup_history_filename_key" ON "backup_history" USING btree ("filename");
