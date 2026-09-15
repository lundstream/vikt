-- Folded names for fuzzy food search (D165).
--
-- 0004 matched typos with `similarity(name, query) > 0.3`, a score over the
-- whole name. A typo inside a longer name stays under it: "Yogghurt" against
-- "Yoghurt naturell fett 3% berikad" is 0.18. And a letter spelled differently
-- on a label than on a keyboard scores nothing at all: "frischgöld" against the
-- brand "Frischgold" is 0.00. Both measured on the development catalogue before
-- this was written.
--
-- So: one generated column holding brand and name, lower-cased, with accented
-- letters folded to their base letter, and one trigram index on it that serves
-- `%`, `<%` and `LIKE` alike. `lower` and `translate` are immutable, so no
-- extension beyond 0004's pg_trgm is needed, and applying this needs only
-- ownership of `food_items` (INFRA.md, "Migrating the database").
--
-- The two letter lists must equal FOLD_FROM and FOLD_TO in
-- `src/lib/search-fold.ts`. `food-search.test.ts` reads this file to
-- hold them together.

ALTER TABLE "food_items"
  ADD COLUMN IF NOT EXISTS "search_name" text
  GENERATED ALWAYS AS (
    translate(lower(coalesce("brand", '') || ' ' || "name"), 'åäöéèêëüáàâïîôç', 'aaoeeeeuaaaiioc')
  ) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "food_items_search_name_trgm_idx"
  ON "food_items" USING GIN ("search_name" gin_trgm_ops);
