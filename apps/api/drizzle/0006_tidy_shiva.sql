-- Macro overrides (D52). Nullable, because null means "use the derived value"
-- and clearing the field is the way back to it.
--
-- The journal `when` for this entry was regenerated below 0005's, which the
-- migrator compares rather than the tag; it is bumped above it by hand. See
-- STATE.md.

ALTER TABLE "profiles" ADD COLUMN "macro_protein_g" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "macro_carbs_g" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "macro_fat_g" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "macro_fiber_g" integer;
