import { z } from "zod";

/**
 * User-defined portions, pantry staples and saved recipes (§6 phase 8).
 *
 * All three are user-owned rows, so all three carry edit and delete (§3, D56).
 * Nothing here changes how anything is stored: `food_entries` remains grams,
 * and a portion is a label plus a multiplier that resolves to grams before
 * anything is written.
 */

/* ------------------------------------------------------------- portions */

/**
 * A portion as stated, before it has been resolved against anything.
 *
 * The unit is kept as written, plural and all, because that is what gets
 * rendered back and Swedish plural is not a suffix rule. Lookup normalises it;
 * display never does.
 */
export const statedPortionSchema = z
  .object({
    count: z.number().positive().max(200),
    unit: z.string().trim().min(1).max(30),
  })
  .strict();
export type StatedPortionInput = z.infer<typeof statedPortionSchema>;

/**
 * Where a gram figure came from.
 *
 * On screen next to the number, always. `estimate` means nothing in the
 * database knew the portion and the figure is a guess, which is a thing the
 * user needs to be told rather than a thing to round away.
 */
export const portionSourceSchema = z.enum(["hint", "user_hint", "estimate"]);

export const foodPortionSchema = z.object({
  id: z.string().uuid(),
  foodItemId: z.string().uuid(),
  unit: z.string(),
  grams: z.number(),
});
export type FoodPortion = z.infer<typeof foodPortionSchema>;

export const createFoodPortionSchema = z.object({
  foodItemId: z.string().uuid(),
  unit: z.string().trim().min(1).max(30),
  grams: z.number().positive().max(5000),
});
export type CreateFoodPortion = z.infer<typeof createFoodPortionSchema>;

export const updateFoodPortionSchema = z.object({
  unit: z.string().trim().min(1).max(30).optional(),
  grams: z.number().positive().max(5000).optional(),
});
export type UpdateFoodPortion = z.infer<typeof updateFoodPortionSchema>;

/* -------------------------------------------------------- pantry staples */

/**
 * Something assumed to be in the kitchen.
 *
 * `negligible` is the load-bearing field and the reason this is not just a list
 * of strings. §6: salt and pepper may be assumed silently; oil, rice and pasta
 * may not, because they still have to appear in the ingredient list and still
 * have to produce food entries. Three tablespoons of oil is roughly 360 kcal,
 * and a recipe that omits it feeds a silently low number into the series TDEE
 * is computed from.
 */
export const pantryStapleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  foodItemId: z.string().uuid().nullable(),
  negligible: z.boolean(),
  /** From the matched food item, so the user can see why it was classed as it was. */
  kcalPer100: z.number().nullable(),
});
export type PantryStaple = z.infer<typeof pantryStapleSchema>;

export const createPantryStapleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /**
   * Optional override. Left out, the classification is derived from the matched
   * food item's energy rather than from the user's judgement (§6).
   */
  negligible: z.boolean().optional(),
});
export type CreatePantryStaple = z.infer<typeof createPantryStapleSchema>;

export const updatePantryStapleSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  negligible: z.boolean().optional(),
});
export type UpdatePantryStaple = z.infer<typeof updatePantryStapleSchema>;

/* --------------------------------------------------------- saved recipes */

/**
 * One line of a saved recipe's ingredient list.
 *
 * Snapshotted rather than joined, for the reason `meal_template_items` keeps a
 * name (D17): deleting the food item leaves a readable line rather than grams
 * of nothing. `portion` is the label it was rendered with, kept so a reopened
 * recipe still reads "2 ägg" rather than reverting to grams.
 */
export const savedRecipeItemSchema = z.object({
  name: z.string(),
  grams: z.number(),
  foodItemId: z.string().uuid().nullable(),
  portion: statedPortionSchema.nullable(),
});
export type SavedRecipeItem = z.infer<typeof savedRecipeItemSchema>;

export const savedRecipeSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  steps: z.array(z.string()),
  items: z.array(savedRecipeItemSchema),
  /** The meal template generated from it, so cooking it again is one tap. */
  templateId: z.string().uuid().nullable(),
  createdAt: z.string(),
});
export type SavedRecipe = z.infer<typeof savedRecipeSchema>;

export const createSavedRecipeSchema = z.object({
  title: z.string().trim().min(1).max(120),
  steps: z.array(z.string().trim().min(1).max(400)).min(1).max(20),
  items: z.array(savedRecipeItemSchema).min(1).max(30),
  /**
   * Whether to generate the meal template at the same time. §6 wants cooking it
   * again to be one tap, and the template is what makes that possible; it
   * reuses the phase 3 path rather than a parallel one.
   */
  createTemplate: z.boolean().default(true),
});
export type CreateSavedRecipe = z.infer<typeof createSavedRecipeSchema>;

/**
 * Editing a saved recipe.
 *
 * The whole point of keeping one: the text is frozen when saved so it cannot
 * silently change, and editable so the user's corrections to timings, amounts
 * and method survive (§6).
 */
export const updateSavedRecipeSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  steps: z.array(z.string().trim().min(1).max(400)).min(1).max(20).optional(),
  items: z.array(savedRecipeItemSchema).min(1).max(30).optional(),
});
export type UpdateSavedRecipe = z.infer<typeof updateSavedRecipeSchema>;
