import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  foodEntries,
  foodFavourites,
  foodItems,
  mealTemplateItems,
  mealTemplates,
} from "../db/schema.js";

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

/** Cache-first search. Always tried before any adapter touches the network. */
/**
 * Local search, ranked by relevance.
 *
 * The previous version was `ILIKE '%query%'` ordered by `fetched_at DESC`,
 * which is import order. Searching "banan" matched forty-odd rows and returned
 * the twelve most recently imported: a chicken gratin, two infant porridges, a
 * Flygande Jakob. The plain "Banan" was in the result set and ranked off the
 * page. The matching was not really the problem; the ordering was.
 *
 * Three ways to match, so that stemming, substrings and typos are all covered:
 *
 *  - the Swedish `tsvector`, via `websearch_to_tsquery`, which stems ("ägg"
 *    finds "Ägg kokt") and which cannot raise a syntax error on user input the
 *    way `to_tsquery` can;
 *  - a plain substring, for partial words a stemmer will not join up;
 *  - trigram similarity, for typos.
 *
 * The ranking is where the real work is:
 *
 *  - an **exact name** dominates everything. Someone typing "banan" wants the
 *    banana;
 *  - then a name that *starts with* the query;
 *  - then `ts_rank` with normalisation 1, which divides by the log of the
 *    document length, so "Banan" beats "Gratäng djungelgratäng m. kyckling
 *    banan mango chutney crème fraiche" for the same matched lexeme;
 *  - then trigram similarity, which carries the near-misses;
 *  - and a **generic bonus** for an unbranded food. For a bare noun the
 *    Livsmedelsverket entry is almost always what was meant; a brand is a
 *    specific request and reads as one ("Marabou", not "choklad").
 */
export async function searchFoodItems(
  userId: string,
  db: Db,
  query: string,
  limit = 20,
): Promise<FoodItemRow[]> {
  const trimmed = query.trim();
  if (trimmed === "") return [];

  /**
   * Whether to prefer the unbranded row, decided once for the query.
   *
   * A bare noun almost always wants the Livsmedelsverket entry: "kvarg" means
   * the food, not a particular tub of it. More than one word is a *specific*
   * request — "lindahls kvarg", "star nutrition proteinpulver" — and there the
   * bonus was actively wrong, demoting the exact product someone had named
   * behind every generic row that shared a word with it.
   *
   * Decided from the query rather than from each row, because it is a fact
   * about the question and not about the answer, and because the version that
   * asked the database per row scanned every brand in the table to do it.
   */
  const genericBonus = trimmed.split(/\s+/).length === 1 ? "1.5" : "0";

  const rows = await db
    .select()
    .from(foodItems)
    .where(
      and(
        sql`(
          ${foodItems.searchVector} @@ websearch_to_tsquery('swedish', ${trimmed})
          OR ${foodItems.name} ILIKE ${"%" + trimmed + "%"}
          /**
           * The brand, matched in its own right.
           *
           * Only the name was matched here, so "star nutrition" found a product
           * called that and nothing merely *made* by them, and the combination a
           * person actually types — brand and product together — matched
           * neither half. The concatenation is what makes "lindahls kvarg" a hit
           * on a row whose name is "Kvarg" and whose brand is "Lindahls".
           */
          OR ${foodItems.brand} ILIKE ${"%" + trimmed + "%"}
          OR (${foodItems.brand} || ' ' || ${foodItems.name}) ILIKE ${"%" + trimmed + "%"}
          OR similarity(${foodItems.name}, ${trimmed}) > ${TRIGRAM_THRESHOLD}
          OR similarity(coalesce(${foodItems.brand}, '') || ' ' || ${foodItems.name}, ${trimmed})
             > ${TRIGRAM_THRESHOLD}
        )`,
        visibleTo(userId),
      ),
    )
    .orderBy(
      sql`(
        CASE WHEN lower(${foodItems.name}) = lower(${trimmed}) THEN 100 ELSE 0 END
        + CASE WHEN ${foodItems.name} ILIKE ${trimmed + "%"} THEN 10 ELSE 0 END
        /**
         * Brand and name together, scored like a name match.
         *
         * Someone looking for a specific product types the brand with it, and
         * before this that phrasing scored *lower* than either word alone.
         */
        + CASE
            WHEN (coalesce(${foodItems.brand}, '') || ' ' || ${foodItems.name})
                 ILIKE ${"%" + trimmed + "%"} THEN 12 ELSE 0
          END
        + ts_rank(
            ${foodItems.searchVector},
            websearch_to_tsquery('swedish', ${trimmed}),
            1
          ) * 8
        + similarity(${foodItems.name}, ${trimmed}) * 4
        /**
         * A generic row is preferred only when the query named no brand.
         *
         * This bonus used to be unconditional, so every branded product was
         * demoted against every generic one — which is precisely the wrong way
         * round for someone searching for a named protein powder, and is the
         * "plausible match pushed off the page" shape the banana defect had.
         * It earns its keep for a bare "kvarg", where the Livsmedelsverket row
         * is the better answer, and it has no business firing for
         * "lindahls kvarg".
         */
        + CASE WHEN ${foodItems.brand} IS NULL THEN ${sql.raw(genericBonus)} ELSE 0 END
      ) DESC, length(${foodItems.name}) ASC`,
    )
    .limit(limit);

  return rows;
}

/**
 * How close a trigram match has to be to count as a match at all.
 *
 * 0.3 is Postgres's own default for the `%` operator. Lower admits noise on
 * short queries, where a three-letter word shares trigrams with a great deal.
 */
const TRIGRAM_THRESHOLD = 0.3;

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
