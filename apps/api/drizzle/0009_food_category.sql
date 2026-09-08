-- The household-measure category (D85). Additive and nullable: every existing
-- row keeps meaning what it meant, and null simply means "no household measure
-- for this food", which is the honest answer for most of them until the
-- adapters have run again.

ALTER TABLE "food_items" ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_items_category_idx" ON "food_items" ("category");
