-- Sharing a meal within the installation (D192).
--
-- A display name on the profile, empty by default: sharing needs one, and the
-- share control is absent without it. And reports: a reader who finds a shared
-- meal that should not be there says so, and Administration decides.
--
-- Additive. The report cascades with the meal and with the reporter, so a
-- removed meal or account leaves no report pointing at nothing; whether one was
-- dealt with is a timestamp, never a nullable foreign key (§3).

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "public_name" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "meal_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meal_id" uuid NOT NULL REFERENCES "meals"("id") ON DELETE CASCADE,
  "reporter_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by_email" text,
  "resolution" text
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "meal_reports_once" ON "meal_reports" ("meal_id", "reporter_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meal_reports_open_idx" ON "meal_reports" ("created_at") WHERE "resolved_at" IS NULL;
