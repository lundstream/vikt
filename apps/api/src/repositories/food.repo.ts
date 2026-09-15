import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  foodEntries,
  foodFavourites,
  foodItems,
  mealTemplateItems,
  mealTemplates,
} from "../db/schema.js";
import { FOLD_FROM, FOLD_TO, foldForSearch } from "../lib/search-fold.js";

export type FoodItemRow = typeof foodItems.$inferSelect;
export type FoodEntryRow = typeof foodEntries.$inferSelect;
export type MealTemplateRow = typeof mealTemplates.$inferSelect;
export type MealTemplateItemRow = typeof mealTemplateItems.$inferSelect;

/**
 * `food_items` is a **shared cache**, not a user-owned table, so most reads here
 * take `userId` only to scope *visibility*. That is the whole point of the
 * `visibility` column (D17): a private item is one whose `visibility` is
 * `private` **and** whose `created_by` is this user. Deleting the creator nulls
 * `created_by`, and the item then matches nobody — invisible, which is the safe
 * direction to fail rather than becoming shared.
 */

/** Shared items, plus this user's own private ones. */
function visibleTo(userId: string): SQL {
  return or(
    eq(foodItems.visibility, "shared"),
    and(eq(foodItems.visibility, "private"), eq(foodItems.createdBy, userId)),
  )!;
}

export async function findFoodByBarcode(
  userId: string,
  db: Db,
  barcode: string,
): Promise<FoodItemRow | undefined> {
  const [row] = await db
    .select()
    .from(foodItems)
    .where(and(eq(foodItems.barcode, barcode), visibleTo(userId)))
    .orderBy(desc(foodItems.fetchedAt))
    .limit(1);
  return row;
}

export async function findFoodBySourceRef(
  userId: string,
  db: Db,
  source: FoodItemRow["source"],
  sourceRef: string,
): Promise<FoodItemRow | undefined> {
  const [row] = await db
    .select()
    .from(foodItems)
    .where(
      and(eq(foodItems.source, source), eq(foodItems.sourceRef, sourceRef), visibleTo(userId)),
    )
    .limit(1);
  return row;
}

export async function findFoodById(
  userId: string,
  db: Db,
  id: string,
): Promise<FoodItemRow | undefined> {
  const [row] = await db
    .select()
    .from(foodItems)
    .where(and(eq(foodItems.id, id), visibleTo(userId)))
    .limit(1);
  return row;
}

/** A user's text inside a LIKE pattern matches itself, not a wildcard. */
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Local search, ranked by relevance.
 *
 * The version before 0004 was `ILIKE '%query%'` ordered by `fetched_at DESC`,
 * which is import order: "banan" returned a chicken gratin before the banana.
 * 0030 added the folded `search_name` and this query moved onto it (D165).
 *
 * **Four ways to match**, each for a failure the others cannot cover:
 *
 *  - the Swedish `tsvector`, which stems ("ägg" finds "Ägg kokt");
 *  - **every word present, in any order**, as a substring of brand and name
 *    folded, so "lindahls kvarg", "kvarg lindahls" and "bananch" all match;
 *  - `search_name % q`, whole-name trigram similarity above 0.3, Postgres's own
 *    default, which catches a misspelt short name ("banna");
 *  - `q <% search_name`, **word** similarity at or above 0.6, again the
 *    default, which catches a misspelt word inside a long name ("Yogghurt"
 *    against "Yoghurt naturell fett 3% berikad" is 0.70 here and 0.18 as a
 *    whole-name score). Folding is what makes "frischgöld" reach "Frischgold".
 *
 * The two thresholds are the cutoff: nothing vaguer is a match at all, and both
 * operators are served by one trigram index.
 *
 * **The ranking does not depend on word order.** An exact name counts for a
 * single word; for several words, every word present and no others counts the
 * same, so "köttbullar mammas" and "mammas köttbullar" put the same row first.
 * Then a name that starts with a single-word query, then every word present,
 * then `ts_rank` normalised by document length, then word similarity, and a
 * small bonus for an unbranded food when the query is one word, because a bare
 * noun almost always wants the Livsmedelsverket row and a brand is a request.
 */
export async function searchFoodItems(
  userId: string,
  db: Db,
  query: string,
  limit = 20,
): Promise<FoodItemRow[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];

  const q = foldForSearch(trimmed);
  const words = q.split(/\s+/).filter((word) => word !== "");
  const single = sql.raw(words.length === 1 ? "true" : "false");
  const genericBonus = sql.raw(words.length === 1 ? "1.5" : "0");

  const everyWord = sql.join(
    words.map((word) => sql`${foodItems.searchName} LIKE ${`%${escapeLike(word)}%`}`),
    sql` AND `,
  );
  const tsQuery = sql`websearch_to_tsquery('swedish', ${trimmed})`;

  const rows = await db
    .select()
    .from(foodItems)
    .where(
      and(
        sql`(
          ${foodItems.searchVector} @@ ${tsQuery}
          OR (${everyWord})
          OR ${foodItems.searchName} % ${q}
          OR ${q} <% ${foodItems.searchName}
        )`,
        visibleTo(userId),
      ),
    )
    .orderBy(
      sql`(
        CASE
          WHEN ${single} AND (
            lower(${foodItems.name}) = lower(${trimmed}) OR btrim(${foodItems.searchName}) = ${q}
          ) THEN 100
          WHEN NOT ${single} AND (${everyWord})
            AND array_length(regexp_split_to_array(btrim(${foodItems.searchName}), '\s+'), 1)
                = ${words.length}
          THEN 100
          ELSE 0
        END
        + CASE
            WHEN ${single}
              AND translate(lower(${foodItems.name}), ${FOLD_FROM}, ${FOLD_TO}) LIKE ${`${escapeLike(q)}%`}
            THEN 10 ELSE 0
          END
        + CASE WHEN (${everyWord}) THEN 12 ELSE 0 END
        + ts_rank(${foodItems.searchVector}, ${tsQuery}, 1) * 8
        + word_similarity(${q}, ${foodItems.searchName}) * 4
        + CASE WHEN ${foodItems.brand} IS NULL THEN ${genericBonus} ELSE 0 END
      ) DESC, length(${foodItems.name}) ASC`,
    )
    .limit(limit);

  return rows;
}


export type FoodItemInsert = Omit<typeof foodItems.$inferInsert, "id" | "fetchedAt">;

/**
 * Caches a looked-up item, or refreshes it if the source has it already.
 *
 * The conflict target is `(source, source_ref)`, which is the unique index the
 * schema already carries. A manual item has a null `source_ref` and so never
 * conflicts — two hand-typed foods with the same name are two foods.
 */
export async function upsertFoodItem(
  userId: string,
  db: Db,
  values: FoodItemInsert,
): Promise<FoodItemRow> {
  if (values.sourceRef === null || values.sourceRef === undefined) {
    const [row] = await db.insert(foodItems).values(values).returning();
    if (!row) throw new Error("upsertFoodItem returned no row");
    return row;
  }

  const [row] = await db
    .insert(foodItems)
    .values(values)
    .onConflictDoUpdate({
      target: [foodItems.source, foodItems.sourceRef],
      set: {
        name: values.name,
        brand: values.brand ?? null,
        kcalPer100: values.kcalPer100,
        proteinPer100: values.proteinPer100 ?? null,
        carbsPer100: values.carbsPer100 ?? null,
        fatPer100: values.fatPer100 ?? null,
        fiberPer100: values.fiberPer100 ?? null,
        saltPer100: values.saltPer100 ?? null,
        servingHints: values.servingHints ?? null,
        barcode: values.barcode ?? null,
        fetchedAt: new Date(),
      },
    })
    .returning();

  if (!row) throw new Error("upsertFoodItem returned no row");
  return row;
}

/* ------------------------------------------------------------ food entries */

export type FoodEntryInsert = Omit<typeof foodEntries.$inferInsert, "userId">;

/** Idempotent on `(user_id, client_uuid)`, like every other log write (§3). */
export async function upsertFoodEntry(
  userId: string,
  db: Db,
  values: FoodEntryInsert,
): Promise<FoodEntryRow> {
  const [row] = await db
    .insert(foodEntries)
    .values({ ...values, userId })
    .onConflictDoUpdate({
      target: [foodEntries.userId, foodEntries.clientUuid],
      set: {
        localDate: values.localDate,
        loggedAt: values.loggedAt ?? new Date(),
        mealSlot: values.mealSlot ?? "snack",
        foodItemId: values.foodItemId ?? null,
        freetext: values.freetext ?? null,
        grams: values.grams,
        kcal: values.kcal,
        proteinG: values.proteinG ?? null,
        carbsG: values.carbsG ?? null,
        fatG: values.fatG ?? null,
        fiberG: values.fiberG ?? null,
        confidence: values.confidence ?? "1.00",
        confirmed: values.confirmed ?? true,
      },
    })
    .returning();

  if (!row) throw new Error("upsertFoodEntry returned no row");
  return row;
}

export async function listFoodEntries(
  userId: string,
  db: Db,
  range: { from?: string | undefined; to?: string | undefined } = {},
): Promise<FoodEntryRow[]> {
  const filters: SQL[] = [eq(foodEntries.userId, userId)];
  if (range.from) filters.push(sql`${foodEntries.localDate} >= ${range.from}`);
  if (range.to) filters.push(sql`${foodEntries.localDate} <= ${range.to}`);

  return db
    .select()
    .from(foodEntries)
    .where(and(...filters))
    .orderBy(desc(foodEntries.localDate), desc(foodEntries.loggedAt));
}

export async function findFoodEntryById(
  userId: string,
  db: Db,
  id: string,
): Promise<FoodEntryRow | null> {
  const [row] = await db
    .select()
    .from(foodEntries)
    .where(and(eq(foodEntries.userId, userId), eq(foodEntries.id, id)))
    .limit(1);

  return row ?? null;
}

export async function updateFoodEntry(
  userId: string,
  db: Db,
  id: string,
  values: Partial<FoodEntryInsert>,
): Promise<FoodEntryRow | null> {
  const [row] = await db
    .update(foodEntries)
    .set(values)
    .where(and(eq(foodEntries.userId, userId), eq(foodEntries.id, id)))
    .returning();

  return row ?? null;
}

export async function deleteFoodEntry(
  userId: string,
  db: Db,
  clientUuid: string,
): Promise<void> {
  await db
    .delete(foodEntries)
    .where(and(eq(foodEntries.userId, userId), eq(foodEntries.clientUuid, clientUuid)));
}

/** By row id, for the delete control on the food screen. */
export async function deleteFoodEntryById(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(foodEntries)
    .where(and(eq(foodEntries.userId, userId), eq(foodEntries.id, id)))
    .returning({ id: foodEntries.id });

  return rows.length > 0;
}

/**
 * The most recently logged distinct foods, newest first.
 *
 * This is the top of the logging screen and therefore the single most important
 * query in the app: repeat logging is what makes day 90 happen, and a food two
 * taps away is the difference.
 */
export async function recentFoods(
  userId: string,
  db: Db,
  limit = 20,
): Promise<FoodEntryRow[]> {
  const rows = await db
    .select()
    .from(foodEntries)
    .where(eq(foodEntries.userId, userId))
    .orderBy(desc(foodEntries.loggedAt))
    .limit(limit * 6);

  const seen = new Set<string>();
  const distinct: FoodEntryRow[] = [];
  for (const row of rows) {
    const key = row.foodItemId ?? `free:${row.freetext ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(row);
    if (distinct.length >= limit) break;
  }
  return distinct;
}

/* ---------------------------------------------------------- meal templates */

export async function listTemplates(userId: string, db: Db): Promise<MealTemplateRow[]> {
  return db
    .select()
    .from(mealTemplates)
    .where(eq(mealTemplates.userId, userId))
    .orderBy(desc(mealTemplates.lastUsedAt), desc(mealTemplates.createdAt));
}

export async function findTemplate(
  userId: string,
  db: Db,
  templateId: string,
): Promise<MealTemplateRow | undefined> {
  const [row] = await db
    .select()
    .from(mealTemplates)
    .where(and(eq(mealTemplates.userId, userId), eq(mealTemplates.id, templateId)))
    .limit(1);
  return row;
}

/**
 * Template items are reached only through a template that has already been
 * scoped to the user, which is why this takes `userId` and joins rather than
 * querying `meal_template_items` directly on an id from the request.
 */
export async function listTemplateItems(
  userId: string,
  db: Db,
  templateId: string,
): Promise<MealTemplateItemRow[]> {
  const template = await findTemplate(userId, db, templateId);
  if (!template) return [];

  return db
    .select()
    .from(mealTemplateItems)
    .where(eq(mealTemplateItems.templateId, templateId))
    .orderBy(mealTemplateItems.position);
}

export async function insertTemplate(
  userId: string,
  db: Db,
  values: { name: string; defaultMealSlot: MealTemplateRow["defaultMealSlot"] },
): Promise<MealTemplateRow> {
  const [row] = await db
    .insert(mealTemplates)
    .values({ userId, ...values })
    .returning();
  if (!row) throw new Error("insertTemplate returned no row");
  return row;
}

export async function replaceTemplateItems(
  userId: string,
  db: Db,
  templateId: string,
  items: Omit<typeof mealTemplateItems.$inferInsert, "templateId">[],
): Promise<void> {
  const template = await findTemplate(userId, db, templateId);
  if (!template) return;

  await db.delete(mealTemplateItems).where(eq(mealTemplateItems.templateId, templateId));
  if (items.length === 0) return;
  await db.insert(mealTemplateItems).values(items.map((item) => ({ ...item, templateId })));
}

export async function renameTemplate(
  userId: string,
  db: Db,
  templateId: string,
  name: string,
): Promise<MealTemplateRow | undefined> {
  const [row] = await db
    .update(mealTemplates)
    .set({ name })
    .where(and(eq(mealTemplates.userId, userId), eq(mealTemplates.id, templateId)))
    .returning();
  return row;
}

export async function touchTemplate(
  userId: string,
  db: Db,
  templateId: string,
): Promise<void> {
  await db
    .update(mealTemplates)
    .set({ lastUsedAt: new Date(), useCount: sql`${mealTemplates.useCount} + 1` })
    .where(and(eq(mealTemplates.userId, userId), eq(mealTemplates.id, templateId)));
}

/**
 * Returns whether a row was actually removed.
 *
 * `void` was not enough. The query has always been scoped by `user_id`, so a
 * stranger's delete removed nothing and leaked nothing — but the route reported
 * 204 anyway, which tells a client a row is gone when it is not. Every other
 * delete in the codebase answers 404 there (milestones, savings rules, manual
 * intake), and the odd one out is the one that hides a bug.
 */
export async function deleteTemplate(
  userId: string,
  db: Db,
  templateId: string,
): Promise<boolean> {
  const rows = await db
    .delete(mealTemplates)
    .where(and(eq(mealTemplates.userId, userId), eq(mealTemplates.id, templateId)))
    .returning({ id: mealTemplates.id });

  return rows.length > 0;
}

/* ----------------------------------------------------------- favourites */

/** The ids this user has starred, for decorating a page of results. */
export async function favouriteIds(userId: string, db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ id: foodFavourites.foodItemId })
    .from(foodFavourites)
    .where(eq(foodFavourites.userId, userId));
  return new Set(rows.map((row) => row.id));
}

/** The starred items themselves, for the list on the food screen. */
export async function listFavourites(userId: string, db: Db): Promise<FoodItemRow[]> {
  return db
    .select({ item: foodItems })
    .from(foodFavourites)
    .innerJoin(foodItems, eq(foodItems.id, foodFavourites.foodItemId))
    .where(and(eq(foodFavourites.userId, userId), visibleTo(userId)))
    .orderBy(desc(foodFavourites.createdAt))
    .then((rows) => rows.map((row) => row.item));
}

export async function setFavourite(
  userId: string,
  db: Db,
  foodItemId: string,
  favourite: boolean,
): Promise<void> {
  if (!favourite) {
    await db
      .delete(foodFavourites)
      .where(
        and(eq(foodFavourites.userId, userId), eq(foodFavourites.foodItemId, foodItemId)),
      );
    return;
  }

  // Starring twice is one star, not an error.
  await db
    .insert(foodFavourites)
    .values({ userId, foodItemId })
    .onConflictDoNothing({ target: [foodFavourites.userId, foodFavourites.foodItemId] });
}

/**
 * How many logged kcal in a range came from an estimated food item (D82).
 *
 * A join rather than a flag on the entry, because "is this an estimate" is a
 * property of the *food* and the entry snapshots its energy, not its
 * provenance. Editing an item from estimate to measured therefore changes what
 * this reports about past days, which is correct: the days did not change, what
 * is known about them did.
 *
 * Freetext entries have no item and are not counted here. They are the user's
 * own typed figure, which is a different kind of uncertainty and already
 * carries its own marking.
 */
export async function estimatedKcalOver(
  userId: string,
  db: Db,
  range: { from?: string | undefined; to?: string | undefined } = {},
): Promise<number> {
  const filters: SQL[] = [eq(foodEntries.userId, userId), eq(foodItems.isEstimate, true)];
  if (range.from) filters.push(sql`${foodEntries.localDate} >= ${range.from}`);
  if (range.to) filters.push(sql`${foodEntries.localDate} <= ${range.to}`);

  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${foodEntries.kcal}), 0)` })
    .from(foodEntries)
    .innerJoin(foodItems, eq(foodItems.id, foodEntries.foodItemId))
    .where(and(...filters));

  return Number(row?.total ?? 0);
}

/**
 * What this user last logged of each of these foods (D85, layer one).
 *
 * Derived from `food_entries` rather than stored in a table of its own, and
 * that is the decision worth stating: "the last amount" is already a fact the
 * log holds exactly, and a second copy would be a second definition to keep in
 * step — which is the failure D44 and D47 exist to prevent. It also means the
 * figure is correct the instant an entry is edited or deleted, with no write
 * path to remember.
 *
 * `DISTINCT ON` is Postgres doing the work: one row per food, the most recent
 * first. The ordering has to repeat the distinct key, which is why it looks
 * redundant and is not.
 */
export async function lastGramsFor(
  userId: string,
  db: Db,
  foodItemIds: readonly string[],
): Promise<Map<string, number>> {
  if (foodItemIds.length === 0) return new Map();

  const rows = await db
    .selectDistinctOn([foodEntries.foodItemId], {
      foodItemId: foodEntries.foodItemId,
      grams: foodEntries.grams,
    })
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.userId, userId),
        inArray(foodEntries.foodItemId, [...foodItemIds]),
      ),
    )
    .orderBy(foodEntries.foodItemId, desc(foodEntries.localDate), desc(foodEntries.loggedAt));

  const byFood = new Map<string, number>();
  for (const row of rows) {
    if (row.foodItemId === null) continue;
    const grams = Number(row.grams);
    if (Number.isFinite(grams) && grams > 0) byFood.set(row.foodItemId, grams);
  }

  return byFood;
}
