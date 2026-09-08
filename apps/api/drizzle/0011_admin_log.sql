-- The administrative audit log (D95). Additive.
--
-- `actor_id` is SET NULL rather than CASCADE: the log has to outlive the admin
-- who wrote it, or removing an account erases exactly the history worth
-- keeping. `actor_email` is the snapshot that keeps the row readable.

CREATE TABLE IF NOT EXISTS "admin_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "actor_email" text NOT NULL,
  "action" text NOT NULL,
  "subject" text,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "admin_log_created_idx" ON "admin_log" ("created_at");
