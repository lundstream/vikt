-- Each reminder gets a weekday time and a weekend one (D136, amended).
--
-- The existing columns keep their names and become the **weekday** pair. That
-- is additive rather than a rename: nothing has to be rewritten, and a row
-- written by the previous build is already correct for Monday to Friday.
--
-- The weekend columns are seeded from the weekday ones, so an account that had
-- 07:00 every day keeps 07:00 every day until somebody changes it. A default of
-- "off at 07:00" would have silently turned the weekend off for anybody who had
-- already set this up, which is a setting changing itself.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_weigh_weekend" boolean NOT NULL DEFAULT false;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_weigh_weekend_minute" integer NOT NULL DEFAULT 420;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_day_weekend" boolean NOT NULL DEFAULT false;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_day_weekend_minute" integer NOT NULL DEFAULT 1320;

UPDATE "profiles" SET
  "remind_weigh_weekend" = "remind_weigh",
  "remind_weigh_weekend_minute" = "remind_weigh_minute",
  "remind_day_weekend" = "remind_day",
  "remind_day_weekend_minute" = "remind_day_minute";
