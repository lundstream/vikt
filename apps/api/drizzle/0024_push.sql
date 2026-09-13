-- Web push: per-device subscriptions and the two reminders (D136).
--
-- One row per browser per account, not one per account: the same person has a
-- phone and a laptop and they subscribe separately. `endpoint` is the push
-- service's URL for that device and is unique across the table, because that
-- is what identifies a device — re-subscribing the same browser has to update
-- the row rather than make a second one.
--
-- Deleted with the account, like everything else user-owned (D107).
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,

  -- The push service's URL for this device, and the two keys it needs to
  -- encrypt to. Opaque to us: we store them and hand them back to the library.
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,

  -- What the browser calls itself, so somebody with three devices can tell
  -- which row is the phone they no longer have. Editable, per D56.
  "label" text NOT NULL DEFAULT '',

  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Touched whenever a notification is accepted for this device, so a dead row
  -- is visible as one that has not been seen for months.
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_key"
  ON "push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx"
  ON "push_subscriptions" ("user_id");

-- The two reminders, on the profile because they are settings rather than
-- events. Off by default: a notification nobody asked for is the fastest way
-- to have notifications turned off for good (§6, phase 11).
--
-- Minutes past midnight in the user's own timezone, which is the same shape the
-- backup schedule uses. 420 is 07:00 and 1320 is 22:00.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_weigh" boolean NOT NULL DEFAULT false;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_weigh_minute" integer NOT NULL DEFAULT 420;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_day" boolean NOT NULL DEFAULT false;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "remind_day_minute" integer NOT NULL DEFAULT 1320;

-- What has already been sent, so a reminder is never sent twice for one day.
--
-- A row per (user, kind, local_date), inserted when the send is attempted. The
-- unique index is the guard rather than a check in code: two schedulers, a
-- retry, or a clock that steps backwards all converge on one row.
--
-- `local_date` is the user's own day (§3), never derived from a UTC timestamp.
CREATE TABLE IF NOT EXISTS "reminder_sends" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "local_date" date NOT NULL,
  "sent_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "reminder_sends_key"
  ON "reminder_sends" ("user_id", "kind", "local_date");
