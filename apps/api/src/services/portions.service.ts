import type {
  CreateFoodPortion,
  CreatePantryStaple,
  CreateSavedRecipe,
  FoodPortion,
  PantryStaple,
  SavedRecipe,
  ServingHints,
  UpdateFoodPortion,
  UpdatePantryStaple,
  UpdateSavedRecipe,
} from "shared";
import { normaliseUnit, toNumber } from "shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { profiles } from "../db/schema.js";
import {
  deletePortion,
  deleteRecipe,
  deleteStaple,
  findRecipe,
  insertRecipe,
  insertStaple,
  listPortions,
  listRecipes,
  listStaples,
  updatePortion,
  updateRecipe,
  updateStaple,
  upsertPortion,
  type PantryStapleRow,
  type SavedRecipeRow,
} from "../repositories/portions.repo.js";
import { searchFoodItems } from "../repositories/food.repo.js";
import { createTemplate } from "./template.service.js";

/* ------------------------------------------------------------- portions */

export async function getPortions(
  userId: string,
  db: Db,
  foodItemIds?: string[],
): Promise<FoodPortion[]> {
  const rows = await listPortions(userId, db, foodItemIds);
  return rows.map((row) => ({
    id: row.id,
    foodItemId: row.foodItemId,
    unit: row.unit,
    grams: toNumber(row.grams),
  }));
}

/**
 * The user's portions for a set of foods, keyed for `resolvePortion`.
 *
 * Returned as a map of food id to hints so a caller resolving twenty
 * ingredients does one query rather than twenty. The lookup itself normalises
 * units, so the key here is the unit as typed.
 */
export async function userHintsFor(
  userId: string,
  db: Db,
  foodItemIds: string[],
): Promise<Map<string, ServingHints>> {
  const rows = await listPortions(userId, db, foodItemIds);
  const byFood = new Map<string, ServingHints>();

  for (const row of rows) {
    const hints = byFood.get(row.foodItemId) ?? {};
    hints[row.unit] = toNumber(row.grams);
    byFood.set(row.foodItemId, hints);
  }

  return byFood;
}

export async function savePortion(
  userId: string,
  db: Db,
  input: CreateFoodPortion,
): Promise<FoodPortion> {
  const row = await upsertPortion(userId, db, input);
  return { id: row.id, foodItemId: row.foodItemId, unit: row.unit, grams: toNumber(row.grams) };
}

export async function editPortion(
  userId: string,
  db: Db,
  id: string,
  input: UpdateFoodPortion,
): Promise<FoodPortion | null> {
  const row = await updatePortion(userId, db, id, input);
  if (!row) return null;
  return { id: row.id, foodItemId: row.foodItemId, unit: row.unit, grams: toNumber(row.grams) };
}

export async function removePortion(userId: string, db: Db, id: string): Promise<boolean> {
  return deletePortion(userId, db, id);
}

/* -------------------------------------------------------- pantry staples */

/**
 * What is in a Swedish kitchen unless someone says otherwise.
 *
 * §6 asks for "a sensible default list the user prunes rather than an empty
 * box", because a feature whose value depends on configuration that nobody does
 * has no value. The classification is the interesting half and is not a
 * judgement call: it comes from the matched food item's energy per 100 g, with
 * these flags as the fallback for the ones the database will not find.
 *
 * Negligible means "may be assumed silently". Everything else still appears in
 * the ingredient list with an amount and still produces a food entry, because
 * three tablespoons of oil is roughly 360 kcal and a recipe that omits it feeds
 * a silently low number into the series TDEE is computed from (§6).
 */
export const DEFAULT_STAPLES: { name: string; negligible: boolean }[] = [
  { name: "salt", negligible: true },
  { name: "svartpeppar", negligible: true },
  { name: "vitlök", negligible: true },
  { name: "gul lök", negligible: true },
  { name: "vinäger", negligible: true },
  { name: "senap", negligible: true },
  { name: "torkade kryddor", negligible: true },
  { name: "buljongtärning", negligible: true },
  { name: "olivolja", negligible: false },
  { name: "rapsolja", negligible: false },
  { name: "smör", negligible: false },
  { name: "vetemjöl", negligible: false },
  { name: "pasta", negligible: false },
  { name: "ris", negligible: false },
  { name: "potatis", negligible: false },
  { name: "krossade tomater", negligible: false },
  { name: "socker", negligible: false },
];

/**
 * Above this, a staple is calorie-bearing whatever the seed list guessed.
 *
 * 50 kcal per 100 g is well clear of anything that is genuinely a seasoning
 * (vinegar is about 20, mustard about 65 and is therefore *not* negligible by
 * this rule, which is the right answer) and well below anything used in
 * quantity. The figure is a threshold in one place rather than a per-item
 * opinion, so a user who disagrees changes the flag rather than the rule.
 */
export const NEGLIGIBLE_KCAL_PER_100 = 50;

export async function getStaples(userId: string, db: Db): Promise<PantryStaple[]> {
  const rows = await listStaples(userId, db);
  return Promise.all(rows.map((row) => describeStaple(userId, db, row)));
}

/**
 * Seeds the default list, once.
 *
 * Guarded by a timestamp on the profile rather than by a row count (§3). An
 * empty staple list is a legitimate state — someone who deleted every default —
 * and a count-based guard would re-seed the list they had just cleared, every
 * time, with no way to stop it.
 */
export async function seedStaplesIfNeeded(userId: string, db: Db): Promise<boolean> {
  const [profile] = await db
    .select({ seededAt: profiles.pantrySeededAt })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  if (!profile || profile.seededAt !== null) return false;

  for (const staple of DEFAULT_STAPLES) {
    await addStaple(userId, db, staple);
  }

  await db
    .update(profiles)
    .set({ pantrySeededAt: new Date() })
    .where(eq(profiles.userId, userId));

  return true;
}

export async function addStaple(
  userId: string,
  db: Db,
  input: CreatePantryStaple & { negligible?: boolean },
): Promise<PantryStaple> {
  const [match] = await searchFoodItems(userId, db, input.name, 1);

  /**
   * Classified from the food item's energy, not from the user's judgement (§6).
   * Asking someone to decide whether flour is calorie-bearing is asking them to
   * do the app's job, and the consequence of a wrong answer lands in their
   * intake series rather than in their opinion.
   */
  const kcalPer100 = match ? toNumber(match.kcalPer100) : null;
  const negligible =
    input.negligible ??
    (kcalPer100 === null
      ? (DEFAULT_STAPLES.find((s) => s.name === input.name)?.negligible ?? false)
      : kcalPer100 < NEGLIGIBLE_KCAL_PER_100);

  const row = await insertStaple(userId, db, {
    name: input.name,
    foodItemId: match?.id ?? null,
    negligible,
  });

  return describeStaple(userId, db, row);
}

export async function editStaple(
  userId: string,
  db: Db,
  id: string,
  input: UpdatePantryStaple,
): Promise<PantryStaple | null> {
  const row = await updateStaple(userId, db, id, input);
  return row ? describeStaple(userId, db, row) : null;
}

export async function removeStaple(userId: string, db: Db, id: string): Promise<boolean> {
  return deleteStaple(userId, db, id);
}

async function describeStaple(
  userId: string,
  db: Db,
  row: PantryStapleRow,
): Promise<PantryStaple> {
  let kcalPer100: number | null = null;

  if (row.foodItemId) {
    const [match] = await searchFoodItems(userId, db, row.name, 1);
    kcalPer100 = match ? toNumber(match.kcalPer100) : null;
  }

  return {
    id: row.id,
    name: row.name,
    foodItemId: row.foodItemId,
    negligible: row.negligible,
    kcalPer100,
  };
}

/* --------------------------------------------------------- saved recipes */

export async function getRecipes(userId: string, db: Db): Promise<SavedRecipe[]> {
  const rows = await listRecipes(userId, db);
  return rows.map(describeRecipe);
}

export async function getRecipe(
  userId: string,
  db: Db,
  id: string,
): Promise<SavedRecipe | null> {
  const row = await findRecipe(userId, db, id);
  return row ? describeRecipe(row) : null;
}

/**
 * Saves a recipe, and the template that makes cooking it again one tap.
 *
 * The template is generated through the **phase 3 path** rather than a parallel
 * one (§6), so a recipe's rows behave exactly like any other saved meal: the
 * same apply endpoint, the same idempotency, the same edit and delete. The
 * recipe holds the prose; the template holds the rows; the link between them is
 * what makes "cook it again" and "read how" two different taps rather than one
 * confused screen.
 *
 * Only priced rows go into the template. An ingredient the database could not
 * price has no nutrition to log, and putting it in the template would produce a
 * zero-energy row on every future application of it (D74).
 */
export async function saveRecipe(
  userId: string,
  db: Db,
  input: CreateSavedRecipe,
): Promise<SavedRecipe> {
  let templateId: string | null = null;

  if (input.createTemplate) {
    const priced = input.items.filter((item) => item.foodItemId !== null);
    if (priced.length > 0) {
      const template = await createTemplate(userId, db, {
        name: input.title,
        items: priced.map((item) => ({
          foodItemId: item.foodItemId!,
          // Never empty: a template item without a name is the D17 failure.
          nameSnapshot: item.name,
          grams: item.grams,
        })),
      });
      templateId = template.id;
    }
  }

  const row = await insertRecipe(userId, db, {
    title: input.title,
    steps: input.steps,
    items: input.items,
    templateId,
  });

  return describeRecipe(row);
}

export async function editRecipe(
  userId: string,
  db: Db,
  id: string,
  input: UpdateSavedRecipe,
): Promise<SavedRecipe | null> {
  const row = await updateRecipe(userId, db, id, input);
  return row ? describeRecipe(row) : null;
}

export async function removeRecipe(userId: string, db: Db, id: string): Promise<boolean> {
  return deleteRecipe(userId, db, id);
}

function describeRecipe(row: SavedRecipeRow): SavedRecipe {
  return {
    id: row.id,
    title: row.title,
    steps: row.steps as string[],
    items: row.items as SavedRecipe["items"],
    templateId: row.templateId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Re-exported so the recipe prompt can normalise a unit without a second import path. */
export { normaliseUnit };
