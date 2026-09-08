-- Outbound mail, password resets, invite requests and the admin flag
-- (D88, D89). Additive: `is_admin` defaults false, so every existing account
-- keeps exactly the authority it had.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "outbound_email" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "to_address" text NOT NULL,
  "template" text NOT NULL,
  "subject" text NOT NULL,
  "body_text" text NOT NULL,
  "body_html" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_email_status_idx"
  ON "outbound_email" ("status", "next_attempt_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_resets_token_key"
  ON "password_resets" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_resets_user_idx"
  ON "password_resets" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "invite_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "reason" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "decided_at" timestamp with time zone,
  "invite_code" text
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invite_requests_email_key"
  ON "invite_requests" (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invite_requests_status_idx"
  ON "invite_requests" ("status", "created_at");
