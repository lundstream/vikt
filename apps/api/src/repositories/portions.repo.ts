import { and, asc, eq, inArray } from "drizzle-orm";
import { normaliseUnit } from "shared";
import type { Db } from "../db/index.js";
import { foodPortions, pantryStaples, savedRecipes } from "../db/schema.js";

export type FoodPortionRow = typeof foodPortions.$inferSelect;
export type PantryStapleRow = typeof pantryStaples.$inferSelect;
export type SavedRecipeRow = typeof savedRecipes.$inferSelect;

/**
 * All three tables here are **user-owned**, unlike `food_items`, so every
 * function scopes by `userId` and takes it first (§3). A portion is one person's
 * kitchen scale, a staple list is one person's cupboard, and a recipe is one
 * person's evening; none of them is a shared cache and none of them has a
 * visibility question attached.
 */

/* ------------------------------------------------------------- portions */

export async function listPortions(
  userId: string,
  db: Db,
  foodItemIds?: string[],
): Promise<FoodPortionRow[]> {
  /**
   * An empty id list means "these specific none", not "all of them". Returning
   * everything here would quietly hand a caller the user's whole portion table
   * when it asked about nothing.
   */
  if (foodItemIds && foodItemIds.length === 0) return [];

  return db
    .select()
    .from(foodPortions)
    .where(
      foodItemIds
        ? and(
            eq(foodPortions.userId, userId),
            inArray(foodPortions.foodItemId, foodItemIds),
          )
        : eq(foodPortions.userId, userId),
    )
    .orderBy(asc(foodPortions.unitKey));
}

export async function upsertPortion(
  userId: string,
  db: Db,
  values: { foodItemId: string; unit: string; grams: number },
): Promise<FoodPortionRow> {
  const [row] = await db
    .insert(foodPortions)
    .values({
      userId,
      foodItemId: values.foodItemId,
      unit: values.unit,
      unitKey: normaliseUnit(values.unit),
      grams: String(values.grams),
    })
    /**
     * Defining "skiva" twice is one portion redefined, not two portions. The
     * conflict target is the normalised unit, so "Skivor" and "skiva" cannot
     * both exist and resolve differently depending on which the lookup found.
     */
    .onConflictDoUpdate({
      target: [foodPortions.userId, foodPortions.foodItemId, foodPortions.unitKey],
      set: { unit: values.unit, grams: String(values.grams) },
    })
    .returning();
  return row!;
}

export async function updatePortion(
  userId: string,
  db: Db,
  id: string,
  values: { unit?: string; grams?: number },
): Promise<FoodPortionRow | undefined> {
  const [row] = await db
    .update(foodPortions)
    .set({
      ...(values.unit === undefined
        ? {}
        : { unit: values.unit, unitKey: normaliseUnit(values.unit) }),
      ...(values.grams === undefined ? {} : { grams: String(values.grams) }),
    })
    .where(and(eq(foodPortions.id, id), eq(foodPortions.userId, userId)))
    .returning();
  return row;
}

export async function deletePortion(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(foodPortions)
    .where(and(eq(foodPortions.id, id), eq(foodPortions.userId, userId)))
    .returning({ id: foodPortions.id });
  return rows.length > 0;
}

/* -------------------------------------------------------- pantry staples */

export async function listStaples(userId: string, db: Db): Promise<PantryStapleRow[]> {
  return db
    .select()
    .from(pantryStaples)
    .where(eq(pantryStaples.userId, userId))
    .orderBy(asc(pantryStaples.name));
}

export async function insertStaple(
  userId: string,
  db: Db,
  values: { name: string; foodItemId: string | null; negligible: boolean },
): Promise<PantryStapleRow> {
  const [row] = await db
    .insert(pantryStaples)
    .values({ userId, ...values })
    // Adding a staple that is already there is not an error, it is a no-op with
    // the newer classification.
    .onConflictDoUpdate({
      target: [pantryStaples.userId, pantryStaples.name],
      set: { foodItemId: values.foodItemId, negligible: values.negligible },
    })
    .returning();
  return row!;
}

export async function updateStaple(
  userId: string,
  db: Db,
  id: string,
  values: { name?: string; negligible?: boolean },
): Promise<PantryStapleRow | undefined> {
  const [row] = await db
    .update(pantryStaples)
    .set(values)
    .where(and(eq(pantryStaples.id, id), eq(pantryStaples.userId, userId)))
    .returning();
  return row;
}

export async function deleteStaple(userId: string, db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(pantryStaples)
    .where(and(eq(pantryStaples.id, id), eq(pantryStaples.userId, userId)))
    .returning({ id: pantryStaples.id });
  return rows.length > 0;
}

/* --------------------------------------------------------- saved recipes */

export async function listRecipes(userId: string, db: Db): Promise<SavedRecipeRow[]> {
  return db
    .select()
    .from(savedRecipes)
    .where(eq(savedRecipes.userId, userId))
    .orderBy(asc(savedRecipes.title));
}

export async function findRecipe(
  userId: string,
  db: Db,
  id: string,
): Promise<SavedRecipeRow | undefined> {
  const [row] = await db
    .select()
    .from(savedRecipes)
    .where(and(eq(savedRecipes.id, id), eq(savedRecipes.userId, userId)))
    .limit(1);
  return row;
}

export async function insertRecipe(
  userId: string,
  db: Db,
  values: {
    title: string;
    steps: string[];
    items: unknown[];
    templateId: string | null;
  },
): Promise<SavedRecipeRow> {
  const [row] = await db.insert(savedRecipes).values({ userId, ...values }).returning();
  return row!;
}

export async function updateRecipe(
  userId: string,
  db: Db,
  id: string,
  values: { title?: string; steps?: string[]; items?: unknown[] },
): Promise<SavedRecipeRow | undefined> {
  const [row] = await db
    .update(savedRecipes)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(savedRecipes.id, id), eq(savedRecipes.userId, userId)))
    .returning();
  return row;
}

export async function deleteRecipe(userId: string, db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(savedRecipes)
    .where(and(eq(savedRecipes.id, id), eq(savedRecipes.userId, userId)))
    .returning({ id: savedRecipes.id });
  return rows.length > 0;
}
