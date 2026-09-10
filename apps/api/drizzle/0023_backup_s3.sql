-- The S3 destination replaces the SMB one (D133).
--
-- Dropping the three `smb_*` columns is a deliberate exception to the additive
-- rule, and it is safe here for one reason that will not hold next time:
-- `0022_backup_smb` has never run outside development. It is listed in
-- STATE.md's "Migrationer som kommer att köras" and `main` has never carried
-- it, so no production database has these columns and none holds a value in
-- them. Production applies 0022 and 0023 in the same startup, adding three
-- columns and dropping them again, which costs one table rewrite of a
-- single-row table.
--
-- If this had shipped, the answer would have been to leave the columns and stop
-- reading them. Dropping a column somebody's data is in is not a migration, it
-- is a deletion.
ALTER TABLE "backup_settings" DROP COLUMN IF EXISTS "smb_host";
ALTER TABLE "backup_settings" DROP COLUMN IF EXISTS "smb_share";
ALTER TABLE "backup_settings" DROP COLUMN IF EXISTS "smb_domain";

-- Everything an S3-compatible endpoint needs that is not a secret. The access
-- key and secret go into `credentials_encrypted` as one encrypted JSON object,
-- the same way the SMTP password is stored.
--
-- `s3_endpoint` empty means AWS itself, which is the one case the SDK infers.
-- `s3_path_style` defaults to true because self-hosted is what this project is
-- for: MinIO and most NAS endpoints require it, and AWS is the exception.
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "s3_endpoint" text NOT NULL DEFAULT '';
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "s3_region" text NOT NULL DEFAULT '';
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "s3_bucket" text NOT NULL DEFAULT '';
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "s3_path_style" boolean NOT NULL DEFAULT true;
