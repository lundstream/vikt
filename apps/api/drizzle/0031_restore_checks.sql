-- Restore checks (D168).
--
-- A backup that has never been restored is a hope. `infra/restore-check.sh`
-- restores a plain dump into a scratch database and has been run by hand; the
-- app's own backups are encrypted, and until this nothing checked that one could
-- be read back at all. Each check leaves a row, whether it worked or not, so the
-- Backup screen can say when a backup was last shown to restore.
--
-- Additive: one new table on the API's own schema. Applying it needs only
-- ownership of the database (INFRA.md, "What role a migration needs"). Running a
-- check needs more, CREATEDB, because it restores into a scratch database; that
-- is a runtime need of the check and not of this migration.

CREATE TABLE IF NOT EXISTS "restore_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "status" text DEFAULT 'running' NOT NULL,
  "trigger" text NOT NULL,
  "file_name" text,
  "tables" integer,
  "rows" integer,
  "migrations" integer,
  "error" text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "restore_checks_started_idx" ON "restore_checks" ("started_at");
