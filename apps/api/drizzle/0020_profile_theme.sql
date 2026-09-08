-- The theme choice belongs to the account (D117). `system` is the default
-- and is a real value, not a null meaning unset: following the OS is a
-- choice, and one somebody can come back to.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "theme" text NOT NULL DEFAULT 'system';
