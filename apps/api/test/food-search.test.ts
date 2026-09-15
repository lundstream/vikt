import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { foodItems } from "../src/db/schema.js";
import { FOLD_FROM, FOLD_TO, foldForSearch } from "../src/lib/search-fold.js";

/**
 * Local food search.
 *
 * The bug these are written against was not the matching, it was the ordering:
 * `ILIKE '%banan%'` matched forty rows and `ORDER BY fetched_at DESC` returned
 * the twelve most recently imported, none of which was the banana. A test that
 * asserted "searching banan returns results" would have passed throughout.
 *
 * So every assertion here is about **rank**, not about presence.
 */

const ctx = useTestApp();

/** A slice of the real Livsmedelsverket shape, plus a branded item. */
const CATALOGUE: {
  name: string;
  brand?: string;
  source: "livsmedelsverket" | "openfoodfacts";
}[] = [
  { name: "Banan", source: "livsmedelsverket" },
  { name: "Banan torkad", source: "livsmedelsverket" },
  { name: "Banan kokbanan", source: "livsmedelsverket" },
  { name: "Bananchips", source: "livsmedelsverket" },
  { name: "Gratäng djungelgratäng m. kyckling banan mango chutney", source: "livsmedelsverket" },
  { name: "Barngröt ätf. havre m. banan äpple mjölkfri osötad berikad", source: "livsmedelsverket" },
  { name: "Flygande Jakob kyckling m. bacon jordnötter banan", source: "livsmedelsverket" },
  { name: "Bananmos", brand: "Semper", source: "openfoodfacts" },
  { name: "Präst", source: "livsmedelsverket" },
  { name: "Prästost 31%", brand: "Arla", source: "openfoodfacts" },
  { name: "Ägg rått", source: "livsmedelsverket" },
  { name: "Ägg kokt", source: "livsmedelsverket" },
  { name: "Ägg stekt", source: "livsmedelsverket" },
  // D165: a misspelt word inside a long name, a folded letter, and word order.
  { name: "Yoghurt naturell fett 3% berikad", source: "livsmedelsverket" },
  { name: "Grekisk yoghurt", source: "livsmedelsverket" },
  { name: "Gräddost", brand: "Frischgold", source: "openfoodfacts" },
  { name: "Mammas köttbullar", brand: "Scan", source: "openfoodfacts" },
  { name: "Köttbullar nöt stekta", source: "livsmedelsverket" },
  { name: "Köttbullar frysvara", source: "livsmedelsverket" },
];

async function search(
  app: FastifyInstance,
  user: TestUser,
  query: string,
  source: "all" | "local" = "all",
): Promise<string[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/food/search?q=${encodeURIComponent(query)}&limit=8&source=${source}`,
    headers: auth(user),
  });
  if (response.statusCode !== 200) {
    throw new Error(`search failed (${response.statusCode}): ${response.body}`);
  }
  return response.json<{ items: { name: string }[] }>().items.map((item) => item.name);
}

describe("local food search", () => {
  /**
   * Seeded directly rather than through the API: these rows stand in for the
   * imported Livsmedelsverket catalogue, which no endpoint creates.
   */
  async function seed(db: ReturnType<typeof ctx>["db"]) {
    await db.insert(foodItems).values(
      CATALOGUE.map((entry, index) => ({
        source: entry.source,
        sourceRef: `test-${index}`,
        name: entry.name,
        brand: entry.brand ?? null,
        visibility: "shared" as const,
        createdBy: null,
        kcalPer100: "100.00",
      })),
    );
  }

  it("puts the plain food first for a bare noun", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    // The exact bug: "Banan" used to be in the result set and off the page.
    expect((await search(app, user, "banan"))[0]).toBe("Banan");
  });

  it("ranks a generic food above a branded one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const results = await search(app, user, "banan");
    expect(results.indexOf("Banan")).toBeLessThan(results.indexOf("Bananmos"));
  });

  it("ranks a short specific name above a long compound dish", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const results = await search(app, user, "banan");
    const compound = results.findIndex((name) => name.startsWith("Flygande Jakob"));

    expect(results.indexOf("Banan torkad")).toBeLessThan(
      compound === -1 ? Number.MAX_SAFE_INTEGER : compound,
    );
  });

  it("finds prästost", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const results = await search(app, user, "prästost");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((name) => name.toLowerCase().includes("präst"))).toBe(true);
  });

  /** Stemming: the Swedish configuration joins the inflected forms. */
  it("finds ägg and its preparations", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const results = await search(app, user, "ägg");
    expect(results.filter((name) => name.startsWith("Ägg")).length).toBeGreaterThanOrEqual(3);
  });

  /** Trigrams: a stemmer cannot help with a transposed letter. */
  it("survives a misspelling", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    expect(await search(app, user, "banna")).toContain("Banan");
  });

  it("matches a partial word", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    expect((await search(app, user, "bananch")).length).toBeGreaterThan(0);
  });

  /**
   * Asserted against the local catalogue rather than the whole response: the
   * service falls through to the food adapters when it has fewer local hits
   * than the limit, and the fixture adapter answers any query at all. What
   * matters here is that *local* search does not degrade into matching
   * everything, which a badly tuned trigram threshold would.
   */
  it("matches nothing locally for a query that matches nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const names = new Set(CATALOGUE.map((entry) => entry.name));
    const results = await search(app, user, "zzzqqq");

    expect(results.filter((name) => names.has(name))).toEqual([]);
  });

  it("keeps a private food out of another user's results", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await db.insert(foodItems).values({
      source: "manual",
      sourceRef: null,
      name: "Hemlig banankaka",
      visibility: "private",
      createdBy: mine.userId,
      kcalPer100: "300.00",
    });

    // Same reason as above: the adapters answer anything, so the assertion is
    // about this one item rather than about an empty response.
    expect(await search(app, theirs, "banankaka")).not.toContain("Hemlig banankaka");
    expect(await search(app, mine, "banankaka")).toContain("Hemlig banankaka");
  });
});

/**
 * Fuzzy matching on the folded name (D165). Asked with `source=local`, so the
 * answer is the database's and no fixture adapter can supply the row.
 */
describe("fuzzy local food search", () => {
  async function seed(db: ReturnType<typeof ctx>["db"]) {
    await db.insert(foodItems).values(
      CATALOGUE.map((entry, index) => ({
        source: entry.source,
        sourceRef: `fuzzy-${index}`,
        name: entry.name,
        brand: entry.brand ?? null,
        visibility: "shared" as const,
        createdBy: null,
        kcalPer100: "100.00",
      })),
    );
  }

  /**
   * 0.18 as a whole-name similarity, which is under 0004's 0.3 cutoff, and 0.70
   * as a word similarity, which is over 0.6. The case the old matcher missed.
   */
  it("finds yoghurt for Yogghurt, a misspelt word inside a long name", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const results = await search(app, user, "Yogghurt", "local");
    expect(results).toContain("Yoghurt naturell fett 3% berikad");
    expect(results[0]?.toLowerCase()).toContain("yoghurt");
  });

  /** 0.00 unfolded: ö and o share no trigram. 1.00 once both are folded. */
  it("finds Frischgold for frischgöld, through the folded brand", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    expect((await search(app, user, "frischgöld", "local"))[0]).toBe("Gräddost");
  });

  it("ranks the same row first for köttbullar mammas as for mammas köttbullar", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    const forwards = await search(app, user, "mammas köttbullar", "local");
    const backwards = await search(app, user, "köttbullar mammas", "local");

    expect(forwards[0]).toBe("Mammas köttbullar");
    expect(backwards[0]).toBe("Mammas köttbullar");
    expect(new Set(backwards)).toEqual(new Set(forwards));
  });

  it("finds a brand and a product in either order", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    expect((await search(app, user, "scan köttbullar", "local"))[0]).toBe("Mammas köttbullar");
    expect((await search(app, user, "köttbullar scan", "local"))[0]).toBe("Mammas köttbullar");
  });

  /** The cutoff: a query that is near nothing matches nothing. */
  it("still matches nothing for a query close to nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    expect(await search(app, user, "zzzqqq", "local")).toEqual([]);
  });

  it("treats a LIKE wildcard in the query as a character, not as match-anything", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(db);

    expect(await search(app, user, "%%%", "local")).toEqual([]);
  });
});

/**
 * The fold is written twice, once in SQL in migration 0030 and once in
 * TypeScript for the query, and the two have to agree or a folded query would
 * miss the folded column.
 */
describe("the fold", () => {
  it("uses the same letters in the migration as in the query", () => {
    const migration = readFileSync(
      path.resolve(import.meta.dirname, "../drizzle/0030_food_search_fold.sql"),
      "utf8",
    );

    expect(migration).toContain(`'${FOLD_FROM}', '${FOLD_TO}'`);
    expect([...FOLD_FROM].length).toBe([...FOLD_TO].length);
  });

  it("folds a query in TypeScript exactly as the database folds the column", async () => {
    const { db } = ctx();
    const sample = "Crème Brûlée ÅÄÖ Frischgöld Ça Über";

    const rows = (await db.execute(
      sql`select translate(lower(${sample}), ${FOLD_FROM}, ${FOLD_TO}) as folded`,
    )) as unknown as { folded: string }[];

    expect(foldForSearch(sample)).toBe(rows[0]!.folded);
  });
});
