-- Backing up to a Windows share, over the protocol rather than through a mount
-- (D130).
--
-- Host and share are their own columns because they are not secrets and are
-- what the screen shows back. The username and password go into the existing
-- `credentials_encrypted` column as one encrypted JSON object, the same way the
-- SMTP password is stored: encrypted at rest under SECRET_KEY, never returned
-- by the API, and unreadable without the key.
--
-- `destination_path` keeps its meaning and changes what it is relative to: a
-- filesystem path for `local`, a folder inside the share for `smb`. Empty means
-- the root of the share.
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "smb_host" text NOT NULL DEFAULT '';
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "smb_share" text NOT NULL DEFAULT '';
ALTER TABLE "backup_settings" ADD COLUMN IF NOT EXISTS "smb_domain" text NOT NULL DEFAULT '';
