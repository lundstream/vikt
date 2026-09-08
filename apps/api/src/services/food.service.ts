import type {
  BarcodeLookup,
  CreateEstimate,
  CreateFoodEntry,
  UpdateFoodEntry,
  FoodEntry,
  FoodItem,
  FoodSearchResult,
  NormalisedFood,
} from "shared";
import { scaleToGrams, toNumber, toNumberOrNull, toNumeric, toNumericOrNull } from "shared";
import type { Db } from "../db/index.js";
import { AdapterUnavailable, type FoodAdapter } from "../food/adapter.js";
import {
  findFoodByBarcode,
  findFoodById,
  findFoodBySourceRef,
  deleteFoodEntryById,
  listFoodEntries,
  recentFoods,
  favouriteIds,
  lastGramsFor,
  listFavourites,
  searchFoodItems,
  setFavourite,
  upsertFoodEntry,
  upsertFoodItem,
  type FoodEntryRow,
  type FoodItemRow,
  findFoodEntryById,
  updateFoodEntry,
} from "../repositories/food.repo.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { assertDateSource, serverDate } from "../lib/date-source.js";

/**
 * Food lookup, always cache-first.
 *
 * Every adapter result is written into `food_items`, so a repeat lookup never
 * touches the network — which matters more than it sounds: Open Food Facts
 * allows 15 product reads a minute **for the whole server**, so a cache miss is
 * a shared resource being spent.
 *
 * When the network is unavailable or the budget is gone, these degrade to
 * cache-only with a message rather than failing. A scanner in a shop basement
 * that returns nothing is a scanner that does not get used again.
 */

/**
 * A cached row as the API returns it.
 *
 * `favourite` is a fact about *this user* and a `food_items` row is shared
 * (D17), so it arrives from the favourites table rather than from the row.
 * Defaulting it to false when the set is not supplied keeps every existing
 * caller honest: unstarred is the safe direction, and a screen that does not
 * care about favourites cannot accidentally claim one.
 */
function toItem(
  row: FoodItemRow,
  favourites?: ReadonlySet<string>,
  lastGrams?: ReadonlyMap<string, number>,
): FoodItem {
  return {
    id: row.id,
    source: row.source,
    sourceRef: row.sourceRef,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    kcalPer100: toNumber(row.kcalPer100),
    proteinPer100: toNumberOrNull(row.proteinPer100),
    carbsPer100: toNumberOrNull(row.carbsPer100),
    fatPer100: toNumberOrNull(row.fatPer100),
    fiberPer100: toNumberOrNull(row.fiberPer100),
    saltPer100: toNumberOrNull(row.saltPer100),
    servingHints: (row.servingHints as Record<string, number> | null) ?? null,
    category: row.category,
    /**
     * What this user last ate of this food (D85, layer one).
     *
     * Supplied by the caller, because it is a per-user fact about a shared row
     * and because looking it up per item would be a query per result.
     */
    lastGrams: lastGrams?.get(row.id) ?? null,
    isEstimate: row.isEstimate,
    estimateBasis: row.estimateBasis,
    favourite: favourites?.has(row.id) ?? false,
    visibility: row.visibility,
  };
}

/** Writes a normalised food into the shared cache. */
async function cache(
  userId: string,
  db: Db,
  food: NormalisedFood,
): Promise<FoodItemRow> {
  return upsertFoodItem(userId, db, {
    source: food.source,
    sourceRef: food.sourceRef,
    barcode: food.barcode,
    name: food.name,
    brand: food.brand,
    createdBy: null,
    // Anything from an adapter is shared; only hand-typed foods are private.
    visibility: "shared",
    kcalPer100: toNumeric(food.kcalPer100, 2),
    proteinPer100: toNumericOrNull(food.macros.proteinG, 2),
    carbsPer100: toNumericOrNull(food.macros.carbsG, 2),
    fatPer100: toNumericOrNull(food.macros.fatG, 2),
    fiberPer100: toNumericOrNull(food.macros.fiberG, 2),
    saltPer100: toNumericOrNull(food.macros.saltG, 2),
    servingHints: food.servingHints,
    category: food.category ?? null,
  });
}

export type FoodDeps = {
  db: Db;
  adapters: FoodAdapter[];
};

/**
 * Barcode lookup. Cache first, then whichever adapters support barcodes.
 *
 * Three distinct answers, because the UI does different things with each: a
 * cached or fetched item; a product that exists but whose energy cannot be
 * trusted (`problem`); and nothing at all.
 */
export async function lookupBarcode(
  userId: string,
  deps: FoodDeps,
  barcode: string,
): Promise<BarcodeLookup> {
  const cached = await findFoodByBarcode(userId, deps.db, barcode);
  if (cached) {
    return { item: toItem(cached), problem: null, cacheOnly: true, notice: null };
  }

  let notice: string | null = null;

  for (const adapter of deps.adapters) {
    if (!adapter.supportsBarcode) continue;
    try {
      const result = await adapter.lookupBarcode(barcode);
      if (result === null) continue;

      if (!result.ok) {
        // The product exists but its energy cannot be determined. Say so and
        // let the user type a number — never guess one (food.ts).
        return {
          item: null,
          problem: result.failure,
          cacheOnly: false,
          notice: null,
        };
      }

      const row = await cache(userId, deps.db, result.food);
      return { item: toItem(row), problem: null, cacheOnly: false, notice: null };
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        notice = unavailableNotice(error);
        continue;
      }
      throw error;
    }
  }

  return { item: null, problem: null, cacheOnly: notice !== null, notice };
}

/**
 * Search. The local cache is always consulted first and its results are
 * returned even when the network is then queried, so an offline or
 * rate-limited search still answers with everything already known.
 */
export async function searchFood(
  userId: string,
  deps: FoodDeps,
  query: string,
  limit: number,
): Promise<FoodSearchResult> {
  const cached = await searchFoodItems(userId, deps.db, query, limit);
  const byKey = new Map(cached.map((row) => [`${row.source}:${row.sourceRef ?? row.id}`, row]));

  let notice: string | null = null;
  let reachedNetwork = false;

  /**
   * A full page of local hits is not the same as a good one.
   *
   * This used to short-circuit on `cached.length >= limit` alone, which meant a
   * query matching twelve loose rows never reached the network at all — and
   * loose is what the local matcher is: substrings, stems and trigrams over a
   * table with thousands of Livsmedelsverket rows in it. Someone searching for
   * a named product got twelve generic near-misses and no reason to think
   * anything else existed.
   *
   * So the budget is only saved when the cache has actually **answered**: a row
   * whose name, or whose brand and name together, matches the query closely.
   * Anything vaguer is a page of maybes, and a page of maybes is worth a
   * request.
   */
  if (cached.length >= limit && cached.some((row) => closeMatch(row, query))) {
    const [stars, last] = await Promise.all([
      favouriteIds(userId, deps.db),
      lastGramsFor(userId, deps.db, cached.map((row) => row.id)),
    ]);
    return {
      items: cached.map((row) => toItem(row, stars, last)),
      cacheOnly: true,
      notice: null,
    };
  }

  for (const adapter of deps.adapters) {
    try {
      const results = await adapter.search(query, limit - byKey.size);
      reachedNetwork = true;
      for (const result of results) {
        if (!result.ok) continue;
        const row = await cache(userId, deps.db, result.food);
        byKey.set(`${row.source}:${row.sourceRef ?? row.id}`, row);
      }
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        notice = unavailableNotice(error);
        continue;
      }
      throw error;
    }
    if (byKey.size >= limit) break;
  }

  const found = [...byKey.values()].slice(0, limit);
  const [stars, last] = await Promise.all([
    favouriteIds(userId, deps.db),
    lastGramsFor(userId, deps.db, found.map((row) => row.id)),
  ]);
  return {
    items: found.map((row) => toItem(row, stars, last)),
    cacheOnly: !reachedNetwork,
    notice,
  };
}

/**
 * Whether a cached row is a convincing answer to the query.
 *
 * Deliberately strict: an exact name, or the query being a prefix of the name
 * or of "brand name". A substring anywhere would readmit exactly the loose
 * matches this is here to distrust.
 */
function closeMatch(row: FoodItemRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  const name = row.name.toLowerCase();
  const branded = `${row.brand ?? ""} ${row.name}`.trim().toLowerCase();
  return name === q || name.startsWith(q) || branded.startsWith(q) || branded.includes(q);
}

function unavailableNotice(error: AdapterUnavailable): string {
  const seconds = error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null;
  return seconds
    ? `Livsmedelsdatabasen är tillfälligt otillgänglig — försök igen om ${seconds} s. Visar det som redan finns sparat.`
    : "Livsmedelsdatabasen är tillfälligt otillgänglig. Visar det som redan finns sparat.";
}

/* ------------------------------------------------------------ food entries */

async function toEntry(userId: string, db: Db, row: FoodEntryRow): Promise<FoodEntry> {
  const item = row.foodItemId ? await findFoodById(userId, db, row.foodItemId) : undefined;

  return {
    id: row.id,
    clientUuid: row.clientUuid,
    localDate: row.localDate,
    loggedAt: row.loggedAt.toISOString(),
    mealSlot: row.mealSlot,
    foodItemId: row.foodItemId,
    name: item?.name ?? row.freetext ?? "Okänd mat",
    brand: item?.brand ?? null,
    grams: toNumber(row.grams),
    kcal: toNumber(row.kcal),
    proteinG: toNumberOrNull(row.proteinG),
    carbsG: toNumberOrNull(row.carbsG),
    fatG: toNumberOrNull(row.fatG),
    fiberG: toNumberOrNull(row.fiberG),
    confidence: toNumber(row.confidence),
    confirmed: row.confirmed,
  };
}

/**
 * Writes a food entry, snapshotting the macros at log time (D4).
 *
 * When a `foodItemId` is given the energy is computed **from the item**, not
 * taken from the request: the client is not the authority on what a food
 * contains, and letting it send its own figure would put an unverifiable number
 * into the series adaptive TDEE is computed from.
 */
export async function saveFoodEntry(
  userId: string,
  db: Db,
  input: CreateFoodEntry,
): Promise<FoodEntry> {
  /**
   * The date and where it came from have to agree (D61). Checked here rather
   * than in the schema, because the answer depends on the server's own clock
   * and a Zod refinement cannot see it.
   */
  assertDateSource(input.localDate, input.dateSource, serverDate());

  let kcal = input.kcal ?? null;
  let macros = {
    proteinG: input.proteinG ?? null,
    carbsG: input.carbsG ?? null,
    fatG: input.fatG ?? null,
    fiberG: input.fiberG ?? null,
  };

  if (input.foodItemId) {
    const item = await findFoodById(userId, db, input.foodItemId);
    if (!item) throw notFound("Den maten finns inte.");

    const scaled = scaleToGrams(
      {
        kcalPer100: toNumber(item.kcalPer100),
        macros: {
          proteinG: toNumberOrNull(item.proteinPer100),
          carbsG: toNumberOrNull(item.carbsPer100),
          fatG: toNumberOrNull(item.fatPer100),
          fiberG: toNumberOrNull(item.fiberPer100),
          saltG: toNumberOrNull(item.saltPer100),
        },
      },
      input.grams,
    );
    kcal = scaled.kcal;
    macros = {
      proteinG: scaled.macros.proteinG,
      carbsG: scaled.macros.carbsG,
      fatG: scaled.macros.fatG,
      fiberG: scaled.macros.fiberG,
    };
  }

  if (kcal === null) {
    // A food with no determinable energy cannot be logged silently (food.ts).
    throw unprocessable(
      "no_energy",
      "Den här maten saknar energivärde. Skriv in kalorierna själv så sparas de som en uppskattning.",
    );
    }

  const row = await upsertFoodEntry(userId, db, {
    clientUuid: input.clientUuid,
    localDate: input.localDate,
    loggedAt: input.loggedAt ? new Date(input.loggedAt) : new Date(),
    mealSlot: input.mealSlot,
    foodItemId: input.foodItemId ?? null,
    freetext: input.freetext ?? null,
    grams: toNumeric(input.grams, 1),
    kcal: toNumeric(kcal, 1),
    proteinG: toNumericOrNull(macros.proteinG, 1),
    carbsG: toNumericOrNull(macros.carbsG, 1),
    fatG: toNumericOrNull(macros.fatG, 1),
    fiberG: toNumericOrNull(macros.fiberG, 1),
    confidence: toNumeric(input.confidence, 2),
    confirmed: input.confirmed,
  });

  return toEntry(userId, db, row);
}

/**
 * Corrects a logged entry's amount, and recomputes what it contains.
 *
 * **The macros are recomputed from the food item**, not scaled from the stored
 * snapshot. Entries denormalise their macros at log time precisely so that a
 * later upstream correction cannot silently move history, and that rule is not
 * being weakened here: an edit is a *new statement about this entry* made now,
 * so it takes the item as it is now. What stays true is that nothing recomputes
 * an entry nobody touched.
 *
 * A freetext entry has no item to read, so its stored values are scaled by the
 * ratio of the amounts. That is the only honest answer available: the numbers
 * were the user's own estimate for a portion, and half the portion is half the
 * estimate.
 */
export async function editFoodEntry(
  userId: string,
  db: Db,
  id: string,
  input: UpdateFoodEntry,
): Promise<FoodEntry> {
  const current = await findFoodEntryById(userId, db, id);
  if (!current) throw notFound("Den här raden finns inte.");

  let kcal: number;
  let macros: { proteinG: number | null; carbsG: number | null; fatG: number | null; fiberG: number | null };

  if (current.foodItemId) {
    const item = await findFoodById(userId, db, current.foodItemId);
    if (!item) throw notFound("Den maten finns inte.");

    const scaled = scaleToGrams(
      {
        kcalPer100: toNumber(item.kcalPer100),
        macros: {
          proteinG: toNumberOrNull(item.proteinPer100),
          carbsG: toNumberOrNull(item.carbsPer100),
          fatG: toNumberOrNull(item.fatPer100),
          fiberG: toNumberOrNull(item.fiberPer100),
          saltG: toNumberOrNull(item.saltPer100),
        },
      },
      input.grams,
    );
    kcal = scaled.kcal;
    macros = {
      proteinG: scaled.macros.proteinG,
      carbsG: scaled.macros.carbsG,
      fatG: scaled.macros.fatG,
      fiberG: scaled.macros.fiberG,
    };
  } else {
    const previousGrams = toNumber(current.grams);
    /**
     * A zero-gram original has no ratio to scale by. Rather than dividing by
     * zero and writing NaN into the series, the figures are left alone: the
     * amount changes and the estimate does not, which is visibly odd and
     * therefore fixable, unlike a silently wrong number.
     */
    const ratio = previousGrams > 0 ? input.grams / previousGrams : 1;
    const scale = (value: string | null) =>
      value === null ? null : toNumber(value) * ratio;

    kcal = toNumber(current.kcal) * ratio;
    macros = {
      proteinG: scale(current.proteinG),
      carbsG: scale(current.carbsG),
      fatG: scale(current.fatG),
      fiberG: scale(current.fiberG),
    };
  }

  const row = await updateFoodEntry(userId, db, id, {
    grams: toNumeric(input.grams, 1),
    kcal: toNumeric(kcal, 1),
    proteinG: toNumericOrNull(macros.proteinG, 1),
    carbsG: toNumericOrNull(macros.carbsG, 1),
    fatG: toNumericOrNull(macros.fatG, 1),
    fiberG: toNumericOrNull(macros.fiberG, 1),
    ...(input.mealSlot ? { mealSlot: input.mealSlot } : {}),
  });

  if (!row) throw notFound("Den här raden finns inte.");
  return toEntry(userId, db, row);
}

export async function getFoodEntries(
  userId: string,
  db: Db,
  range: { from?: string | undefined; to?: string | undefined },
): Promise<FoodEntry[]> {
  const rows = await listFoodEntries(userId, db, range);
  return Promise.all(rows.map((row) => toEntry(userId, db, row)));
}

/** The recent list that opens the logging screen. */
export async function getRecentFoods(
  userId: string,
  db: Db,
  limit = 20,
): Promise<FoodEntry[]> {
  const rows = await recentFoods(userId, db, limit);
  return Promise.all(rows.map((row) => toEntry(userId, db, row)));
}

/** A hand-typed food, private to its creator. */
export async function createManualFood(
  userId: string,
  db: Db,
  input: { name: string; kcalPer100: number; brand?: string | null },
): Promise<FoodItem> {
  const row = await upsertFoodItem(userId, db, {
    source: "manual",
    sourceRef: null,
    barcode: null,
    name: input.name,
    brand: input.brand ?? null,
    createdBy: userId,
    visibility: "private",
    kcalPer100: toNumeric(input.kcalPer100, 2),
    proteinPer100: null,
    carbsPer100: null,
    fatPer100: null,
    fiberPer100: null,
    saltPer100: null,
    servingHints: null,
  });
  return toItem(row);
}

export async function getFoodItem(userId: string, db: Db, id: string): Promise<FoodItem> {
  const row = await findFoodById(userId, db, id);
  if (!row) throw notFound("Den maten finns inte.");
  return toItem(row);
}

export async function findCachedBySourceRef(
  userId: string,
  db: Db,
  source: FoodItemRow["source"],
  sourceRef: string,
): Promise<FoodItem | null> {
  const row = await findFoodBySourceRef(userId, db, source, sourceRef);
  return row ? toItem(row) : null;
}

/**
 * Removes one logged food entry.
 *
 * The day's intake is a sum over the remaining rows (`calc/intake.ts`), so
 * deleting one simply changes the total on the next read. Nothing stored needs
 * correcting, which is the property that makes this safe to offer inline.
 */
export async function removeFoodEntry(
  userId: string,
  deps: FoodDeps,
  id: string,
): Promise<void> {
  if (!(await deleteFoodEntryById(userId, deps.db, id))) {
    throw notFound("Det finns ingen sådan matpost.");
  }
}

/* ------------------------------------------- estimates and favourites (D80) */

/**
 * A restaurant meal or a takeaway, valued by the person who ate it.
 *
 * The independent-pizzeria case: no barcode, nothing in any database, and the
 * alternative to letting someone type a figure is the day going unlogged, which
 * is worse for every number downstream than an honest guess is.
 *
 * Stored as a **reusable** food item rather than a one-off row, which is the
 * decision worth stating: the same pizzeria recurs, and re-typing the guess
 * every Friday would put a different number into the intake series each time
 * for the same meal. A remembered estimate is stable, editable, and marked.
 *
 * Private, because it is one person's guess about one restaurant. Nothing about
 * it belongs in the shared cache other users search.
 */
export async function createEstimate(
  userId: string,
  db: Db,
  input: CreateEstimate,
): Promise<FoodItem> {
  /**
   * The user says what the portion weighed and what it was worth; the cache
   * stores per 100 g like every other row. Deriving it here rather than asking
   * for it is the difference between a question someone can answer and one
   * nobody can: nobody knows the kcal per 100 g of a pizza.
   */
  const per100 = (value: number | null | undefined): string | null =>
    value === null || value === undefined
      ? null
      : toNumeric((value * 100) / input.grams, 2);

  const row = await upsertFoodItem(userId, db, {
    source: "manual",
    sourceRef: null,
    barcode: null,
    name: input.name,
    brand: input.brand ?? null,
    createdBy: userId,
    visibility: "private",
    kcalPer100: toNumeric((input.kcal * 100) / input.grams, 2),
    proteinPer100: per100(input.proteinG),
    carbsPer100: per100(input.carbsG),
    fatPer100: per100(input.fatG),
    fiberPer100: null,
    saltPer100: null,
    /**
     * The portion it was estimated for, kept as a serving hint so logging it
     * again offers the same amount rather than asking the question twice.
     */
    servingHints: { portion: input.grams },
    isEstimate: true,
    estimateBasis: input.basis ?? null,
  });

  return toItem(row);
}

export async function getFavourites(userId: string, db: Db): Promise<FoodItem[]> {
  const rows = await listFavourites(userId, db);
  const stars = new Set(rows.map((row) => row.id));
  const last = await lastGramsFor(userId, db, rows.map((row) => row.id));
  return rows.map((row) => toItem(row, stars, last));
}

export async function starFood(
  userId: string,
  db: Db,
  foodItemId: string,
  favourite: boolean,
): Promise<void> {
  await setFavourite(userId, db, foodItemId, favourite);
}
