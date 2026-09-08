-- What a background worker last did (D104).
--
-- Hand-written, for the reason 0012 and 0013 give: the snapshot chain in meta/
-- has gaps and `drizzle-kit generate` diffs against the newest snapshot it can
-- find rather than against the database.

CREATE TABLE IF NOT EXISTS "worker_heartbeat" (
	"name" text PRIMARY KEY NOT NULL,
	"last_tick_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_since_start" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
