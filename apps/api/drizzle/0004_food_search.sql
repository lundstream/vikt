-- Real text search over `food_items`.
--
-- Before this, local search was `ILIKE '%query%'` ordered by `fetched_at DESC`,
-- which is import order and has nothing to do with relevance. Searching "banan"
-- matched 40-odd rows and returned the twelve most recently imported: a chicken
-- gratin, two infant porridges, a Flygande Jakob. The plain "Banan" was in the
-- result set and ranked out of the page.
--
-- Two mechanisms, because they cover different failures:
--   * a Swedish `tsvector` for stemming, so "ägg" finds "Ägg kokt" and a query
--     is matched on lexemes rather than on characters;
--   * trigrams for typos and partial words, which stemming cannot help with.
--
-- Written by hand rather than generated: drizzle-kit expresses neither an
-- extension nor a generated column.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- Generated, so it cannot drift from the row. A trigger would have to be
-- remembered by every writer; this cannot be forgotten.
ALTER TABLE "food_items"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'swedish',
      coalesce("name", '') || ' ' || coalesce("brand", '')
    )
  ) STORED;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "food_items_search_idx"
  ON "food_items" USING GIN ("search_vector");
--> statement-breakpoint

-- Trigram index on the name alone. Brands are matched by the tsvector; a typo
-- in a brand name is a rarer problem than a typo in a food name.
CREATE INDEX IF NOT EXISTS "food_items_name_trgm_idx"
  ON "food_items" USING GIN ("name" gin_trgm_ops);
