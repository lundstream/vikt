-- Scheduled backups, with their runs recorded (D103).
--
-- Hand-written, for the reason 0012 gives: the snapshot chain in meta/ has gaps
-- and `drizzle-kit generate` diffs against the newest snapshot it can find
-- rather than against the database, so it emits every table added since 0008.
--
-- Additive: two new tables, nothing altered, nothing dropped.

CREATE TABLE IF NOT EXISTS "backup_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"destination_kind" text DEFAULT 'local' NOT NULL,
	"destination_path" text DEFAULT '' NOT NULL,
	"credentials_encrypted" text DEFAULT '' NOT NULL,
	"schedule_minute" integer,
	"retain_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_email" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"started_by_email" text,
	"destination" text DEFAULT '' NOT NULL,
	"file_name" text,
	"bytes" integer,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_runs_started_idx" ON "backup_runs" USING btree ("started_at");
