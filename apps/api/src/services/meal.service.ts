import type { CreateMeal, LogMeal, Meal, MealLogResult, SharedMeal, UpdateMeal } from "shared";
import {
  gramsForPortions,
  mealNutrition,
  priceMealRow,
  toNumber,
  toNumberOrNull,
  toNumeric,
  toNumericOrNull,
} from "shared";
import type { Db } from "../db/index.js";
import {
  deleteMeal as deleteMealRow,
  findCopyOf,
  findMeal,
  findSharedMeal,
  insertMealReport,
  listSharedMeals,
  insertMeal,
  listMealItems,
  listMeals,
  mealLogExists,
  recentMealLogs,
  replaceMealItems,
  touchMeal,
  updateMeal,
  type MealItemWithFood,
  type MealRow,
} from "../repositories/meal.repo.js";
import { findFoodById, upsertFoodEntry, upsertFoodItem } from "../repositories/food.repo.js";
import { findProfile } from "../repositories/users.repo.js";
import { toEntry } from "./food.service.js";
import { deriveUuid } from "../lib/derive-uuid.js";
import { assertDateSource, serverDate } from "../lib/date-source.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { mealPhotoKey, MediaUnavailable, type MediaStore } from "../lib/media.js";
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE,
  jpegDimensions,
  readJpegOrientation,
  stripJpegMetadata,
} from "shared";

/**
 * Måltider (Phase 14, D186).
 *
 * A meal is a dish with a portion count. Its per-portion figures come from
 * `mealNutrition` in the shared calc and nowhere else; a logging writes
 * ordinary food rows, scaled per portion and priced from the food as it is
 * now, which makes each logged day its own snapshot.
 */

/** Ninety days of logging decides the order of the row at the top of Mat. */
export const RECENT_LOG_DAYS = 90;

const MISSING_FOOD =
  "Ett av livsmedlen finns inte längre, eller är inte ditt. Välj det igen.";

function rowFood(item: MealItemWithFood) {
  return item.food === null
    ? null
    : {
        kcalPer100: toNumber(item.food.kcalPer100),
        proteinPer100: toNumberOrNull(item.food.proteinPer100),
        carbsPer100: toNumberOrNull(item.food.carbsPer100),
        fatPer100: toNumberOrNull(item.food.fatPer100),
        fiberPer100: toNumberOrNull(item.food.fiberPer100),
      };
}

/** A meal as the API returns it, with its per-portion figures. */
function toMeal(row: MealRow, items: readonly MealItemWithFood[], recentLogs: number): Meal {
  const portions = toNumber(row.portions);
  const priced = items.map((item) => ({ grams: toNumber(item.grams), food: rowFood(item) }));

  return {
    id: row.id,
    clientUuid: row.clientUuid,
    name: row.name,
    portions,
    defaultMealSlot: row.defaultMealSlot,
    recentLogs,
    loggedCount: row.loggedCount,
    lastLoggedAt: row.lastLoggedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items: items.map((item) => ({
      id: item.id,
      foodItemId: item.food === null ? null : item.foodItemId,
      name: item.food?.name ?? item.nameSnapshot,
      brand: item.food?.brand ?? null,
      amount: toNumber(item.amount),
      unit: item.unit,
      grams: toNumber(item.grams),
      position: item.position,
      food:
        item.food === null
          ? null
          : { ...rowFood(item)!, isEstimate: item.food.isEstimate },
    })),
    perPortion: mealNutrition(priced, portions),
    photoUrl:
      row.photoKey === null
        ? null
        : `/api/meals/${row.id}/photo?v=${(row.photoUpdatedAt ?? row.updatedAt).getTime()}`,
    sharedAt: row.sharedAt?.toISOString() ?? null,
    copiedFromName: row.copiedFromName,
  };
}

function groupItems(items: readonly MealItemWithFood[]): Map<string, MealItemWithFood[]> {
  const byMeal = new Map<string, MealItemWithFood[]>();
  for (const item of items) {
    const list = byMeal.get(item.mealId) ?? [];
    list.push(item);
    byMeal.set(item.mealId, list);
  }
  return byMeal;
}

function since(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The person's meals, most used first.
 *
 * By loggings in the last ninety days, then by the last time it was logged,
 * then newest first: the row at the top of Mat shows the first few, and the
 * Måltider section lists them all in the same order so the two never disagree
 * about which meal is "the usual".
 */
export async function getMeals(userId: string, db: Db, now = new Date()): Promise<Meal[]> {
  const rows = await listMeals(userId, db);
  const items = groupItems(await listMealItems(userId, db, rows.map((row) => row.id)));
  const recent = await recentMealLogs(userId, db, since(RECENT_LOG_DAYS, now));

  return rows
    .map((row) => toMeal(row, items.get(row.id) ?? [], recent.get(row.id) ?? 0))
    .sort(
      (a, b) =>
        b.recentLogs - a.recentLogs ||
        (b.lastLoggedAt ?? "").localeCompare(a.lastLoggedAt ?? "") ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

export async function getMeal(userId: string, db: Db, mealId: string): Promise<Meal> {
  const row = await findMeal(userId, db, mealId);
  if (!row) throw notFound("Det finns ingen sådan måltid.");
  const items = await listMealItems(userId, db, [row.id]);
  const recent = await recentMealLogs(userId, db, since(RECENT_LOG_DAYS));
  return toMeal(row, items, recent.get(row.id) ?? 0);
}

/**
 * Every food a new row names has to be one this person can see (§3, D17).
 *
 * Without this a meal could point at somebody else's private food by id, and
 * the list would then price it, which is that food's figures leaking through a
 * side door. The repository prices only visible foods as well; this refuses
 * the write rather than storing a row that would price as nothing.
 */
async function assertFoodsVisible(
  userId: string,
  db: Db,
  foodItemIds: readonly (string | null)[],
): Promise<void> {
  for (const id of new Set(foodItemIds)) {
    if (id === null) continue;
    if (!(await findFoodById(userId, db, id))) throw unprocessable("unknown_food", MISSING_FOOD);
  }
}

function itemValues(items: CreateMeal["items"] | NonNullable<UpdateMeal["items"]>) {
  return items.map((item, position) => ({
    foodItemId: item.foodItemId,
    nameSnapshot: item.nameSnapshot,
    amount: toNumeric(item.amount, 2),
    unit: item.unit,
    grams: toNumeric(item.grams, 1),
    position,
  }));
}

export async function createMeal(userId: string, db: Db, input: CreateMeal): Promise<Meal> {
  await assertFoodsVisible(userId, db, input.items.map((item) => item.foodItemId));

  const row = await db.transaction(async (tx) => {
    const { row, created } = await insertMeal(userId, tx, {
      clientUuid: input.clientUuid,
      name: input.name,
      portions: toNumeric(input.portions, 2),
      defaultMealSlot: input.defaultMealSlot ?? null,
    });
    // A replayed create is the same meal; its rows are already there.
    if (created) await replaceMealItems(userId, tx, row.id, itemValues(input.items));
    return row;
  });

  return getMeal(userId, db, row.id);
}

/**
 * An edit replaces what it names. A row the meal already had may keep a food
 * that has since gone; a row whose food changed must name one that exists.
 */
export async function editMeal(
  userId: string,
  db: Db,
  mealId: string,
  input: UpdateMeal,
): Promise<Meal> {
  const current = await findMeal(userId, db, mealId);
  if (!current) throw notFound("Det finns ingen sådan måltid.");

  if (input.items) {
    const existing = await listMealItems(userId, db, [mealId]);
    const kept = new Set(
      existing.filter((item) => item.food !== null).map((item) => item.foodItemId),
    );
    const gone = existing.filter((item) => item.food === null).length;
    await assertFoodsVisible(
      userId,
      db,
      input.items
        .map((item) => item.foodItemId)
        .filter((id) => id !== null && !kept.has(id)),
    );
    if (input.items.filter((item) => item.foodItemId === null).length > gone) {
      throw unprocessable("unknown_food", MISSING_FOOD);
    }
  }

  await db.transaction(async (tx) => {
    await updateMeal(userId, tx, mealId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.portions !== undefined ? { portions: toNumeric(input.portions, 2) } : {}),
      ...(input.defaultMealSlot !== undefined ? { defaultMealSlot: input.defaultMealSlot } : {}),
    });
    if (input.items) await replaceMealItems(userId, tx, mealId, itemValues(input.items));
  });

  return getMeal(userId, db, mealId);
}

/**
 * Removes the meal. The days it was logged on keep their rows: those are the
 * person's own record of what they ate, and their name and portions are
 * snapshots on the rows themselves.
 *
 * Returns the removed row so the caller can remove its photo (item 6).
 */
export async function removeMeal(userId: string, db: Db, mealId: string): Promise<MealRow> {
  const row = await deleteMealRow(userId, db, mealId);
  if (!row) throw notFound("Det finns ingen sådan måltid.");
  return row;
}

/**
 * Logs `portions` of a meal onto a day, as ordinary food rows.
 *
 * Each row is the ingredient's grams scaled by portions eaten over portions
 * made, priced from the food as it is now, and carries the meal's name and the
 * portions so the day can say "Frukost · 1 portion" above it. Later edits to
 * the meal change none of this (the brief's snapshot rule): the rows are the
 * record.
 *
 * All the rows or none, in one transaction: a template wrote one row at a time,
 * and a failure half way left half a breakfast on the day.
 *
 * A row whose food is gone cannot be priced and is not logged; its name comes
 * back in `skipped` so the screen can say so rather than log a meal that is
 * quietly lighter than it reads.
 */
export async function logMeal(
  userId: string,
  db: Db,
  mealId: string,
  input: LogMeal,
): Promise<MealLogResult> {
  assertDateSource(input.localDate, input.dateSource, serverDate());

  const meal = await findMeal(userId, db, mealId);
  if (!meal) throw notFound("Det finns ingen sådan måltid.");
  const items = await listMealItems(userId, db, [mealId]);
  const makes = toNumber(meal.portions);

  const priced = items.filter((item) => item.food !== null);
  const skipped = items.filter((item) => item.food === null).map((item) => item.nameSnapshot);
  if (priced.length === 0) {
    throw unprocessable(
      "nothing_to_log",
      "Ingen av måltidens rader har ett livsmedel kvar att räkna på. Redigera måltiden först.",
    );
  }

  const loggedAt = input.loggedAt ? new Date(input.loggedAt) : new Date();
  const slot = input.mealSlot ?? meal.defaultMealSlot ?? "snack";

  const rows = await db.transaction(async (tx) => {
    const replay = await mealLogExists(userId, tx, input.clientUuid);

    const written = [];
    for (const item of priced) {
      const grams = gramsForPortions(toNumber(item.grams), input.portions, makes);
      const price = priceMealRow({ grams, food: rowFood(item) })!;
      written.push(
        await upsertFoodEntry(userId, tx, {
          clientUuid: deriveUuid(input.clientUuid, item.position),
          localDate: input.localDate,
          loggedAt,
          mealSlot: slot,
          foodItemId: item.foodItemId,
          freetext: null,
          grams: toNumeric(grams, 1),
          kcal: toNumeric(price.kcal, 1),
          proteinG: toNumericOrNull(price.macros.proteinG, 1),
          carbsG: toNumericOrNull(price.macros.carbsG, 1),
          fatG: toNumericOrNull(price.macros.fatG, 1),
          fiberG: toNumericOrNull(price.macros.fiberG, 1),
          confidence: "1.00",
          confirmed: true,
          mealId: meal.id,
          mealLogUuid: input.clientUuid,
          mealName: meal.name,
          mealPortions: toNumeric(input.portions, 2),
        }),
      );
    }

    // Counted once per logging, not once per replay of it.
    if (!replay) await touchMeal(userId, tx, meal.id);
    return written;
  });

  return {
    entries: await Promise.all(rows.map((row) => toEntry(userId, db, row))),
    skipped,
  };
}

/* ------------------------------------------------------------ the photo */

/**
 * A meal's one photo (D191), checked and cleaned before it is stored.
 *
 * The phone already resized it, turned it upright and dropped its EXIF (D190,
 * `lib/photo.ts`). The server does not take that on trust, because a client
 * that is not this one could send the original: **a JPEG only, no longer than
 * 1 280 px on either side, upright, and stored with every metadata segment
 * removed**, so no photograph kept here carries a location, a time or a phone
 * model whatever sent it. A picture tagged as turned is refused rather than
 * stripped, because stripping the tag would store it sideways.
 *
 * Stored under a new key each time and the old one removed after the meal
 * points at the new, so a reader never gets a key that has gone.
 */
export async function setMealPhoto(
  userId: string,
  db: Db,
  media: MediaStore,
  mealId: string,
  base64: string,
): Promise<Meal> {
  const meal = await findMeal(userId, db, mealId);
  if (!meal) throw notFound("Det finns ingen sådan måltid.");

  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length > PHOTO_MAX_BYTES) {
    throw unprocessable("photo_too_large", "Bilden är för stor. Ta den igen.");
  }
  const size = jpegDimensions(bytes);
  const clean = size === null ? null : stripJpegMetadata(bytes);
  if (size === null || clean === null) {
    throw unprocessable("not_a_photo", "Det där är inte en JPEG-bild appen kan läsa.");
  }
  if (Math.max(size.width, size.height) > PHOTO_MAX_EDGE) {
    throw unprocessable(
      "photo_too_large",
      `Bilden är större än ${PHOTO_MAX_EDGE} px. Välj den från appen, så förminskas den först.`,
    );
  }
  if (readJpegOrientation(bytes) !== 1) {
    throw unprocessable(
      "photo_not_upright",
      "Bilden är märkt som vriden. Välj den från appen, så vänds den rätt först.",
    );
  }

  const key = mealPhotoKey(userId, mealId);
  try {
    await media.put(key, Buffer.from(clean));
  } catch (error) {
    if (error instanceof MediaUnavailable) throw unprocessable("media_unavailable", error.message);
    throw error;
  }
  await updateMeal(userId, db, mealId, { photoKey: key, photoUpdatedAt: new Date() });
  if (meal.photoKey !== null) await media.delete(meal.photoKey).catch(() => {});
  return getMeal(userId, db, mealId);
}

export async function removeMealPhoto(
  userId: string,
  db: Db,
  media: MediaStore,
  mealId: string,
): Promise<Meal> {
  const meal = await findMeal(userId, db, mealId);
  if (!meal) throw notFound("Det finns ingen sådan måltid.");
  if (meal.photoKey !== null) {
    await updateMeal(userId, db, mealId, { photoKey: null, photoUpdatedAt: new Date() });
    await media.delete(meal.photoKey).catch(() => {});
  }
  return getMeal(userId, db, mealId);
}

/**
 * A meal's photo, for the person whose meal it is (§3). A stranger's request
 * is the same 404 as a meal with no photo: whether a photo exists is itself
 * something only its owner learns.
 */
export async function readMealPhoto(
  userId: string,
  db: Db,
  media: MediaStore,
  mealId: string,
): Promise<Buffer> {
  // The owner's own, or a meal shared with everyone here (D192).
  const meal = (await findMeal(userId, db, mealId)) ?? (await findSharedMeal(userId, db, mealId));
  if (!meal || meal.photoKey === null) throw notFound("Det finns inget foto.");
  const bytes = await media.get(meal.photoKey);
  if (bytes === null) throw notFound("Det finns inget foto.");
  return bytes;
}

/* --------------------------------------------------- sharing (D192) */

/**
 * The meals shared on this installation, priced as their authors see them.
 *
 * A meal is priced from its own rows and the foods they point at, as its owner
 * can see them, which for a shared meal is the author: a food private to the
 * author still prices the author's meal, and becomes the reader's own private
 * copy the moment they copy the meal.
 */
export async function getSharedMeals(userId: string, db: Db): Promise<SharedMeal[]> {
  const rows = await listSharedMeals(userId, db);
  const byAuthor = new Map<string, typeof rows>();
  for (const row of rows) byAuthor.set(row.userId, [...(byAuthor.get(row.userId) ?? []), row]);

  const items = new Map<string, MealItemWithFood[]>();
  for (const [authorId, authored] of byAuthor) {
    for (const [mealId, list] of groupItems(
      await listMealItems(authorId, db, authored.map((row) => row.id)),
    )) {
      items.set(mealId, list);
    }
  }

  return rows.map((row) => ({
    ...toMeal(row, items.get(row.id) ?? [], 0),
    authorName: row.authorName,
    isOwn: row.userId === userId,
  }));
}

/**
 * Sharing a meal with everyone on this installation, never beyond it.
 *
 * Two conditions, both checked here as well as on the screen: a display name
 * on the profile, which is what readers see beside it, and the sharer's word
 * that the recipe is theirs to share (the schema takes only `true`).
 */
export async function shareMeal(userId: string, db: Db, mealId: string): Promise<Meal> {
  const meal = await findMeal(userId, db, mealId);
  if (!meal) throw notFound("Det finns ingen sådan måltid.");
  const profile = await findProfile(userId, db);
  if (!profile?.publicName?.trim()) {
    throw unprocessable(
      "no_public_name",
      "Ange ett visningsnamn under Profil först. Det är namnet andra ser bredvid måltiden.",
    );
  }
  if (meal.sharedAt === null) await updateMeal(userId, db, mealId, { sharedAt: new Date() });
  return getMeal(userId, db, mealId);
}

export async function unshareMeal(userId: string, db: Db, mealId: string): Promise<Meal> {
  const meal = await findMeal(userId, db, mealId);
  if (!meal) throw notFound("Det finns ingen sådan måltid.");
  if (meal.sharedAt !== null) await updateMeal(userId, db, mealId, { sharedAt: null });
  return getMeal(userId, db, mealId);
}

/**
 * A shared meal, copied into the reader's own meals as a snapshot.
 *
 * **The copy is theirs from the moment it exists**: the author's later edits
 * change nothing in it, and removing the author's meal or account leaves it.
 * Every row keeps its amount, unit and grams; a food the reader can already see
 * is pointed at as it is, and a food private to the author becomes a private
 * copy of the reader's own, because the reader cannot see the author's and a
 * meal that prices as nothing is not a copy. The photo is copied into the
 * reader's folder. The name and the author's display name at the time are
 * kept, so the copy can say where it came from.
 *
 * One copy per reader and shared meal: a second save or a later logging finds
 * the first rather than making another.
 */
export async function copySharedMeal(
  userId: string,
  db: Db,
  media: MediaStore,
  sharedMealId: string,
  clientUuid: string,
): Promise<Meal> {
  const shared = await findSharedMeal(userId, db, sharedMealId);
  if (!shared) throw notFound("Det finns ingen sådan delad måltid.");
  if (shared.userId === userId) {
    throw unprocessable("own_meal", "Det här är din egen måltid.");
  }

  const existing = await findCopyOf(userId, db, sharedMealId);
  if (existing) return getMeal(userId, db, existing.id);

  const items = await listMealItems(shared.userId, db, [shared.id]);

  const copied = await db.transaction(async (tx) => {
    const rows = [];
    for (const item of items) {
      let foodItemId: string | null = null;
      if (item.foodItemId !== null && item.food !== null) {
        if (await findFoodById(userId, tx, item.foodItemId)) {
          foodItemId = item.foodItemId;
        } else {
          const original = await findFoodById(shared.userId, tx, item.foodItemId);
          if (original) {
            const { id: _id, fetchedAt: _fetched, searchVector: _vector, searchName: _name, ...values } = original;
            const copy = await upsertFoodItem(userId, tx, {
              ...values,
              sourceRef: null,
              createdBy: userId,
              visibility: "private",
            });
            foodItemId = copy.id;
          }
        }
      }
      rows.push({
        foodItemId,
        nameSnapshot: item.food?.name ?? item.nameSnapshot,
        amount: item.amount,
        unit: item.unit,
        grams: item.grams,
        position: item.position,
      });
    }

    const { row } = await insertMeal(userId, tx, {
      clientUuid,
      name: shared.name,
      portions: shared.portions,
      defaultMealSlot: shared.defaultMealSlot,
      copiedFromMealId: shared.id,
      copiedFromName: shared.authorName,
    });
    await replaceMealItems(userId, tx, row.id, rows);
    return row;
  });

  if (shared.photoKey !== null) {
    const bytes = await media.get(shared.photoKey).catch(() => null);
    if (bytes !== null) {
      const key = mealPhotoKey(userId, copied.id);
      await media.put(key, bytes);
      await updateMeal(userId, db, copied.id, { photoKey: key, photoUpdatedAt: new Date() });
    }
  }

  return getMeal(userId, db, copied.id);
}

/**
 * Logging a shared meal logs the reader's copy of it (D192): the copy is made
 * the first time, and the rows come from it, so the author's later edits
 * change no day the reader has logged.
 */
export async function logSharedMeal(
  userId: string,
  db: Db,
  media: MediaStore,
  sharedMealId: string,
  input: LogMeal,
): Promise<MealLogResult & { mealId: string }> {
  const copy = await copySharedMeal(userId, db, media, sharedMealId, deriveUuid(input.clientUuid, 9999));
  const result = await logMeal(userId, db, copy.id, input);
  return { ...result, mealId: copy.id };
}

/** A reader saying a shared meal should not be shared. Administration decides. */
export async function reportSharedMeal(
  userId: string,
  db: Db,
  sharedMealId: string,
  reason: string,
): Promise<void> {
  const shared = await findSharedMeal(userId, db, sharedMealId);
  if (!shared) throw notFound("Det finns ingen sådan delad måltid.");
  if (shared.userId === userId) throw unprocessable("own_meal", "Det här är din egen måltid.");
  await insertMealReport(userId, db, sharedMealId, reason);
}
