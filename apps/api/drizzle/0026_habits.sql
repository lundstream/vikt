-- The habit checklist (D137): the user's own words, ticked per day.
--
-- Two tables, because a habit and a tick are different things with different
-- lifetimes: the habit is a definition somebody writes once and edits, the tick
-- is a log row like every other log row in this schema, with a `client_uuid` so
-- the offline queue can replay it and a `local_date` the client computed (§3).
--
-- `archived_at` rather than a row that disappears: deleting a habit keeps its
-- history unless the person asks for the history to go too, and history that
-- outlives its habit needs the habit row to still say what it was called. The
-- hard delete is a real delete and takes the checks with it by cascade.
--
-- The reminder columns carry the two-time shape from D136 unchanged: a weekday
-- pair and a weekend pair, each with its own switch. A third notion of what a
-- weekend is would be the one setting on the screen that behaves differently
-- from the two beside it.

CREATE TABLE IF NOT EXISTS "habits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- The user's words. "D-vitamin", "två liter vatten", "stretcha rygg".
  "name" text NOT NULL,
  -- A key into the app's line icon set, or null for no icon. Never a file, and
  -- never arbitrary text: the set is closed and the server checks membership.
  "icon" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "remind" boolean NOT NULL DEFAULT false,
  "remind_minute" integer NOT NULL DEFAULT 480,
  "remind_weekend" boolean NOT NULL DEFAULT false,
  "remind_weekend_minute" integer NOT NULL DEFAULT 480,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Set when the habit is removed from the checklist with its history kept.
  -- A timestamp rather than a boolean, and nothing cascades to it (§3).
  "archived_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "habits_user_idx" ON "habits" ("user_id", "sort_order");

CREATE TABLE IF NOT EXISTS "habit_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "habit_id" uuid NOT NULL REFERENCES "habits"("id") ON DELETE CASCADE,
  "client_uuid" uuid NOT NULL,
  "local_date" date NOT NULL,
  -- False is a row that says "asked and not done today", which is not the same
  -- as no row at all: the streak counts a day nobody answered as unknown, and
  -- an unticked day as a miss. Unticking has to leave a trace or the two are
  -- indistinguishable.
  "checked" boolean NOT NULL DEFAULT true,
  "logged_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "habit_checks_client_key"
  ON "habit_checks" ("user_id", "client_uuid");

CREATE UNIQUE INDEX IF NOT EXISTS "habit_checks_day_key"
  ON "habit_checks" ("user_id", "habit_id", "local_date");

-- The streak reads every check for one habit, and the "was this day answered
-- at all" question reads every check for one day.
CREATE INDEX IF NOT EXISTS "habit_checks_habit_idx"
  ON "habit_checks" ("user_id", "habit_id", "local_date");
CREATE INDEX IF NOT EXISTS "habit_checks_day_idx"
  ON "habit_checks" ("user_id", "local_date");
