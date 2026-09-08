-- `search_vector` is deliberately absent from this migration.
--
-- drizzle-kit generated an `ADD COLUMN "search_vector" tsvector` here, because
-- schema.ts now declares the column and the generator cannot see that
-- 0004_food_search.sql already created it as `GENERATED ALWAYS AS ... STORED`.
-- Running both fails with "column already exists", and running the generated
-- one *instead* would produce a plain column that nothing maintains.
--
-- Migrations are additive and never edited once applied (§7). This one had not
-- been applied anywhere when the conflict was found, so it is corrected rather
-- than followed by a migration undoing it.

ALTER TABLE "profiles" ADD COLUMN "last_drink_on" date;
