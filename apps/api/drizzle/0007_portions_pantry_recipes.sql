-- Phase 8: portions (D73), pantry staples (D75) and saved recipes (D76).
--
-- Additive only. Nothing existing changes shape, and every new column is
-- nullable or defaulted, so the running deployment keeps working while this
-- lands.

CREATE TABLE IF NOT EXISTS "food_portions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "food_item_id" uuid NOT NULL REFERENCES "food_items"("id") ON DELETE cascade,
  "unit" text NOT NULL,
  "unit_key" text NOT NULL,
  "grams" numeric(8, 2) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "food_portions_key"
  ON "food_portions" ("user_id", "food_item_id", "unit_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_portions_user_idx"
  ON "food_portions" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "pantry_staples" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "food_item_id" uuid REFERENCES "food_items"("id") ON DELETE set null,
  "negligible" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "pantry_staples_name"
  ON "pantry_staples" ("user_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pantry_staples_user_idx"
  ON "pantry_staples" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "saved_recipes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "steps" jsonb NOT NULL,
  "items" jsonb NOT NULL,
  "template_id" uuid REFERENCES "meal_templates"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "saved_recipes_user_idx"
  ON "saved_recipes" ("user_id", "created_at");--> statement-breakpoint

-- "Have the defaults been seeded", as a timestamp nothing cascades to (§3).
-- An empty staple list is a legitimate state and must not be re-seeded.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "pantry_seeded_at" timestamp with time zone;
