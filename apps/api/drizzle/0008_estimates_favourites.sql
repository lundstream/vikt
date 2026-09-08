-- Estimates and favourites (D80, D81).
--
-- Additive. `is_estimate` defaults false, so every existing row keeps meaning
-- exactly what it meant.

ALTER TABLE "food_items" ADD COLUMN IF NOT EXISTS "is_estimate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "food_items" ADD COLUMN IF NOT EXISTS "estimate_basis" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "food_favourites" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "food_item_id" uuid NOT NULL REFERENCES "food_items"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "food_favourites_key"
  ON "food_favourites" ("user_id", "food_item_id");
