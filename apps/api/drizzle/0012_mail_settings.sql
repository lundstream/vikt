-- Mail settings move from the environment into the database (D102).
--
-- Hand-written rather than generated. `drizzle-kit generate` produced a file
-- that recreated every table added since 0008, because the snapshot chain in
-- meta/ has gaps where earlier migrations were also written by hand, and it
-- diffs against the newest snapshot it can find rather than against the
-- database. That is STATE.md's drizzle gotcha, and applying the generated file
-- would have failed on the first `CREATE TABLE` that already exists.
--
-- Additive, like every migration here: one new table, nothing altered, nothing
-- dropped. The SMTP_* environment variables keep working until the first boot
-- after this, which imports them once (see mail-settings.service.ts).

CREATE TABLE IF NOT EXISTS "mail_settings" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 587 NOT NULL,
	"security" text DEFAULT 'starttls' NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"password_encrypted" text DEFAULT '' NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_email" text
);
