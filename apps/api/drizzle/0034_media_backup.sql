-- Meal photos in the backups (D191).
--
-- The app's scheduled backup writes the photos beside each dump as
-- vikt-<time>.media.enc, and the restore check opens that archive and checks
-- that every photo the restored database points at is in it. Each records how
-- many photos it saw, so Administration, Backup can say so. Additive.

ALTER TABLE "backup_runs" ADD COLUMN IF NOT EXISTS "media_files" integer;
--> statement-breakpoint
ALTER TABLE "restore_checks" ADD COLUMN IF NOT EXISTS "media_files" integer;
