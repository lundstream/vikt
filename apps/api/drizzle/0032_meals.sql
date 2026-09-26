-- Måltider (Phase 14, D186).
--
-- A meal is a dish with a portion count, and it replaces the meal template,
-- which was a named set of rows logged again at the same grams. Every template
-- becomes a meal of one portion, **keeping its id**, so the recipes that point at
-- one keep pointing at the same thing, and its items become ingredient rows of
-- the same grams with the unit "g". Nothing a template held is dropped:
--
--   meal_templates.name               -> meals.name
--   meal_templates.default_meal_slot  -> meals.default_meal_slot
--   meal_templates.use_count          -> meals.logged_count
--   meal_templates.last_used_at       -> meals.last_logged_at
--   meal_templates.created_at         -> meals.created_at
--   meal_template_items.*             -> meal_items.* (amount = grams, unit 'g')
--
-- `migration-meals.test.ts` applies every migration before this one, writes
-- templates, applies this one, and reads them back as meals.
--
-- **Not additive**, and named as the exception (CLAUDE.md §7): the brief says
-- the old storage is removed, and two tables holding the same meals is how two
-- screens come to disagree about them. The copy runs before the drop in the
-- same transaction, so a failure leaves the templates where they were. Rolling
-- the image back past this migration needs the dump the release takes first.
--
-- Room left for the later items of the phase, on this table, so they need no
-- second migration of it: a photo (item 6), sharing (item 7), and where a copy
-- came from.

CREATE TABLE IF NOT EXISTS "meals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_uuid" uuid NOT NULL,
  "name" text NOT NULL,
  "portions" numeric(6, 2) DEFAULT '1' NOT NULL,
  "default_meal_slot" "meal_slot",
  "logged_count" integer DEFAULT 0 NOT NULL,
  "last_logged_at" timestamp with time zone,
  "photo_key" text,
  "photo_updated_at" timestamp with time zone,
  "shared_at" timestamp with time zone,
  "copied_from_meal_id" uuid,
  "copied_from_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "meals_portions_positive" CHECK ("portions" > 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "meals_client_key" ON "meals" ("user_id", "client_uuid");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meals_user_idx" ON "meals" ("user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meals_shared_idx" ON "meals" ("shared_at") WHERE "shared_at" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "meal_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "meal_id" uuid NOT NULL REFERENCES "meals"("id") ON DELETE CASCADE,
  "food_item_id" uuid REFERENCES "food_items"("id") ON DELETE SET NULL,
  "name_snapshot" text NOT NULL,
  "amount" numeric(8, 2) NOT NULL,
  "unit" text DEFAULT 'g' NOT NULL,
  "grams" numeric(7, 1) NOT NULL,
  "position" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "meal_items_meal_idx" ON "meal_items" ("meal_id", "position");
--> statement-breakpoint

-- The templates, as meals of one portion. The template's id is the meal's id,
-- and so is its client_uuid: a template was never written by the offline queue
-- and has none of its own, and the id is unique per user already.
INSERT INTO "meals" (
  "id", "user_id", "client_uuid", "name", "portions", "default_meal_slot",
  "logged_count", "last_logged_at", "created_at", "updated_at"
)
SELECT
  "id", "user_id", "id", "name", 1, "default_meal_slot",
  "use_count", "last_used_at", "created_at", coalesce("last_used_at", "created_at")
FROM "meal_templates"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- A freetext row keeps its words as the name: `name_snapshot` has been written
-- by the service since 0002, and a row from before it had only `freetext`.
INSERT INTO "meal_items" (
  "id", "meal_id", "food_item_id", "name_snapshot", "amount", "unit", "grams", "position"
)
SELECT
  "id", "template_id", "food_item_id",
  coalesce(nullif("name_snapshot", ''), "freetext", ''),
  "grams", 'g', "grams", "position"
FROM "meal_template_items"
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- A recipe points at the meal it made, by the same id it had.
-- 0007 declared the reference inline, so Postgres named it; both spellings are
-- dropped so the drop of meal_templates below has nothing left depending on it.
ALTER TABLE "saved_recipes" DROP CONSTRAINT IF EXISTS "saved_recipes_template_id_fkey";
--> statement-breakpoint
ALTER TABLE "saved_recipes" DROP CONSTRAINT IF EXISTS "saved_recipes_template_id_meal_templates_id_fk";
--> statement-breakpoint
ALTER TABLE "saved_recipes" RENAME COLUMN "template_id" TO "meal_id";
--> statement-breakpoint
ALTER TABLE "saved_recipes"
  ADD CONSTRAINT "saved_recipes_meal_id_meals_id_fk"
  FOREIGN KEY ("meal_id") REFERENCES "meals"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- A logged meal is ordinary rows that carry where they came from, so the day
-- reads "Frukost · 1 portion" with the rows underneath. All four are null on a
-- row that was not logged from a meal, which is every row before this.
--
-- `meal_id` is a reference and nothing tests it for null to mean anything
-- (§3): the group is `meal_log_uuid`, and the name and portions are snapshots,
-- so deleting the meal changes no logged day.
ALTER TABLE "food_entries" ADD COLUMN IF NOT EXISTS "meal_id" uuid REFERENCES "meals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "food_entries" ADD COLUMN IF NOT EXISTS "meal_log_uuid" uuid;
--> statement-breakpoint
ALTER TABLE "food_entries" ADD COLUMN IF NOT EXISTS "meal_name" text;
--> statement-breakpoint
ALTER TABLE "food_entries" ADD COLUMN IF NOT EXISTS "meal_portions" numeric(6, 2);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "food_entries_meal_idx" ON "food_entries" ("user_id", "meal_id", "logged_at") WHERE "meal_id" IS NOT NULL;
--> statement-breakpoint

DROP TABLE IF EXISTS "meal_template_items";
--> statement-breakpoint
DROP TABLE IF EXISTS "meal_templates";
