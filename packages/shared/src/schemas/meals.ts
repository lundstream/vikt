import { z } from "zod";
import { clientUuidSchema, dateSourceSchema, localDateSchema } from "./log.js";
import { foodEntrySchema, mealSlotSchema } from "./food.js";

/**
 * Måltider (Phase 14, D186): a dish with a portion count.
 *
 * Replaced the meal template. What changed in the contract is the portion
 * count, the amount and unit on every row, and a log that asks how many
 * portions were eaten; what did not is that the database prices every row and
 * the client never sends a figure.
 */

/** Portions a meal makes, or were eaten. Decimals allowed; never zero. */
export const portionsSchema = z.number().gt(0).max(100);

const macroTotalSchema = z.object({
  grams: z.number().nullable(),
  coverage: z.number(),
  complete: z.boolean(),
});

/** `mealNutrition`'s answer, as the API sends it. Per portion. */
export const mealNutritionSchema = z.object({
  kcal: z.number().nullable(),
  kcalComplete: z.boolean(),
  protein: macroTotalSchema,
  carbs: macroTotalSchema,
  fat: macroTotalSchema,
  fiber: macroTotalSchema,
});
export type MealNutritionResponse = z.infer<typeof mealNutritionSchema>;

export const mealItemSchema = z.object({
  id: z.string().uuid(),
  foodItemId: z.string().uuid().nullable(),
  /** The food's name now, or the name it had when added if it is gone (D17). */
  name: z.string(),
  brand: z.string().nullable(),
  amount: z.number(),
  unit: z.string(),
  grams: z.number(),
  position: z.number().int(),
  /**
   * What the row is priced from, so the sheet can run `mealNutrition` on rows
   * being edited. Null when the food is gone.
   */
  food: z
    .object({
      kcalPer100: z.number(),
      proteinPer100: z.number().nullable(),
      carbsPer100: z.number().nullable(),
      fatPer100: z.number().nullable(),
      fiberPer100: z.number().nullable(),
      isEstimate: z.boolean(),
    })
    .nullable(),
});
export type MealItem = z.infer<typeof mealItemSchema>;

export const mealSchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  name: z.string(),
  portions: z.number(),
  defaultMealSlot: mealSlotSchema.nullable(),
  /** Logs in the last ninety days: what the row at the top of Mat is sorted by. */
  recentLogs: z.number().int(),
  loggedCount: z.number().int(),
  lastLoggedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(mealItemSchema),
  perPortion: mealNutritionSchema,
  /** The photo, through the authenticated endpoint (item 6). Null: none. */
  photoUrl: z.string().nullable().default(null),
  /** Shared with this installation since then (item 7). Null: not shared. */
  sharedAt: z.string().nullable().default(null),
  /** Whose shared meal this was copied from, by their display name then. */
  copiedFromName: z.string().nullable().default(null),
});
export type Meal = z.infer<typeof mealSchema>;

export const mealListSchema = z.object({ meals: z.array(mealSchema) });

export const mealItemInputSchema = z.object({
  foodItemId: z.string().uuid(),
  /** The name as it read when added, kept if the food is later removed. */
  nameSnapshot: z.string().trim().min(1).max(200),
  amount: z.number().gt(0).max(10000),
  /** "g", "dl", "st", or a portion the food defines. Display only. */
  unit: z.string().trim().min(1).max(40),
  /** What the amount came to. The number the arithmetic uses. */
  grams: z.number().gt(0).max(10000),
});
export type MealItemInput = z.infer<typeof mealItemInputSchema>;

export const createMealSchema = z.object({
  clientUuid: clientUuidSchema,
  name: z.string().trim().min(1).max(80),
  portions: portionsSchema.default(1),
  defaultMealSlot: mealSlotSchema.nullish(),
  items: z.array(mealItemInputSchema).min(1).max(60),
});
export type CreateMeal = z.infer<typeof createMealSchema>;

/**
 * An edit replaces what it names. Items, when present, are the whole list: a
 * sheet that edits one row sends them all, which is what keeps positions
 * honest and a removed row removed.
 *
 * A row the meal already had may keep a food that is gone (`foodItemId` null),
 * so an edit to the name of a meal with such a row does not force a choice
 * about it. A new row needs a food.
 */
export const updateMealSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  portions: portionsSchema.optional(),
  defaultMealSlot: mealSlotSchema.nullish(),
  items: z
    .array(
      mealItemInputSchema.extend({ foodItemId: z.string().uuid().nullable() }),
    )
    .min(1)
    .max(60)
    .optional(),
});
export type UpdateMeal = z.infer<typeof updateMealSchema>;

/**
 * Logging a meal: how many portions, on which day.
 *
 * `clientUuid` names the logging, not a row. Each row's own key is derived from
 * it and the row's position, so a replay of the same logging writes the same
 * rows and a second logging of the same meal writes new ones (§3).
 */
export const logMealSchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  mealSlot: mealSlotSchema.nullish(),
  portions: portionsSchema.default(1),
  loggedAt: z.string().datetime({ offset: true }).nullish(),
  dateSource: dateSourceSchema.optional(),
});
export type LogMeal = z.infer<typeof logMealSchema>;

export const mealLogResultSchema = z.object({
  entries: z.array(foodEntrySchema),
  /** Rows not logged because their food is gone, by name. */
  skipped: z.array(z.string()),
});
export type MealLogResult = z.infer<typeof mealLogResultSchema>;

/* ------------------------------------------------------ sharing (D192) */

/**
 * A meal shared with everyone on this installation, as a reader sees it: the
 * author's display name and nothing else about them.
 */
export const sharedMealSchema = mealSchema.extend({
  authorName: z.string(),
  /** The reader's own shared meal, which the list shows but cannot copy. */
  isOwn: z.boolean(),
});
export type SharedMeal = z.infer<typeof sharedMealSchema>;

export const sharedMealListSchema = z.object({ meals: z.array(sharedMealSchema) });

/**
 * Sharing, confirmed. The sharer says the recipe is theirs to share, because a
 * cookbook's text belongs to its author; the literal `true` is the only answer
 * the schema takes.
 */
export const shareMealSchema = z.object({ mayShare: z.literal(true) });

export const copySharedMealSchema = z.object({ clientUuid: clientUuidSchema });

export const reportSharedMealSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
