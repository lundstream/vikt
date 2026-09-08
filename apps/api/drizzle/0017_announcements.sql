-- Announcements, and who has seen them (D108).
--
-- Hand-written for the reason 0012 gives about the snapshot chain.

CREATE TABLE IF NOT EXISTS "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"lead_minutes" integer DEFAULT 1440 NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"published" boolean DEFAULT false NOT NULL,
	"send_mail" boolean DEFAULT false NOT NULL,
	"mailed_at" timestamp with time zone,
	"created_by_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcement_seen" (
	"announcement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_version" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "announcement_seen" ADD CONSTRAINT "announcement_seen_announcement_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_seen" ADD CONSTRAINT "announcement_seen_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_kind_idx" ON "announcements" USING btree ("kind","published","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "announcement_seen_key" ON "announcement_seen" USING btree ("announcement_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcement_seen_user_idx" ON "announcement_seen" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "news_mail" boolean DEFAULT true NOT NULL;
