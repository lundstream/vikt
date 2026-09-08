CREATE TYPE "public"."food_visibility" AS ENUM('private', 'shared');--> statement-breakpoint
ALTER TABLE "food_items" ADD COLUMN "visibility" "food_visibility" DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "meal_template_items" ADD COLUMN "name_snapshot" text DEFAULT '' NOT NULL;