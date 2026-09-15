import { z } from "zod";
import { clientUuidSchema, dateSourceSchema, localDateSchema } from "./log.js";

/**
 * Food logging contracts.
 *
 * Every macro is nullable throughout: a food with unknown protein contributes
 * unknown protein, never zero (food.ts). The same rule as intake resolution.
 */

export const mealSlotSchema = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export type MealSlot = z.infer<typeof mealSlotSchema>;

export const foodSourceSchema = z.enum([
  "openfoodfacts",
  "livsmedelsverket",
  "manual",
  "llm_estimate",
]);

export const foodItemSchema = z.object({
  id: z.string().uuid(),
  source: foodSourceSchema,
  sourceRef: z.string().nullable(),
  barcode: z.string().nullable(),
  name: z.string(),
  brand: z.string().nullable(),
  kcalPer100: z.number(),
  proteinPer100: z.number().nullable(),
  carbsPer100: z.number().nullable(),
  fatPer100: z.number().nullable(),
  fiberPer100: z.number().nullable(),
  saltPer100: z.number().nullable(),
  servingHints: z.record(z.number()).nullable(),
  /**
   * Which household-measure table applies (D85). Null means none does, and the
   * food falls back to grams, which the screen says rather than hides.
   */
  category: z.string().nullable().default(null),
  /** What this user last logged of this food. The strongest portion signal. */
  lastGrams: z.number().nullable().default(null),
  /**
   * Whether the numbers are an estimate rather than a measurement (D80).
   *
   * Shown wherever the item is, because a guess the user cannot tell from a
   * packet reading is a guess they will treat as a fact.
   */
  isEstimate: z.boolean().default(false),
  /** What the estimate was based on, so it can be judged rather than accepted. */
  estimateBasis: z.string().nullable().default(null),
  /** Whether this user has starred it. */
  favourite: z.boolean().default(false),
  /** Whether this is the user's own private food. */
  visibility: z.enum(["private", "shared"]),
});
export type FoodItem = z.infer<typeof foodItemSchema>;

/**
 * A search result carries where it came from, because the UI treats them
 * differently: a cached hit is instant and offline-safe, a network hit is not.
 */
export const foodSearchResultSchema = z.object({
  items: z.array(foodItemSchema),
  /** True when the network was skipped — rate limited, or offline. */
  cacheOnly: z.boolean(),
  /** Set when the network was skipped, so the UI can say why. */
  notice: z.string().nullable(),
  /**
   * The cache has already answered, so asking the food databases would spend
   * the shared budget for nothing (D165). A client searching in two parts does
   * not ask for the second.
   */
  enough: z.boolean(),
  /** The food databases did not answer before the deadline. Local results stand. */
  timedOut: z.boolean(),
});
export type FoodSearchResult = z.infer<typeof foodSearchResultSchema>;

/** A barcode miss and a barcode that cannot be trusted are different answers. */
export const barcodeLookupSchema = z.object({
  item: foodItemSchema.nullable(),
  /** Set when a product was found but could not be normalised (units, energy). */
  problem: z
    .object({
      reason: z.enum([
        "no_energy",
        "unknown_energy_unit",
        "inconsistent_energy",
        "no_name",
      ]),
      message: z.string(),
    })
    .nullable(),
  cacheOnly: z.boolean(),
  notice: z.string().nullable(),
});
export type BarcodeLookup = z.infer<typeof barcodeLookupSchema>;

export const barcodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6,14}$/, "en streckkod är 6–14 siffror");

/** Minimum query length, so search is never wired straight to keystrokes. */
export const MIN_SEARCH_LENGTH = 3;

export const foodSearchQuerySchema = z.object({
  q: z.string().trim().min(MIN_SEARCH_LENGTH).max(100),
  limit: z.coerce.number().int().min(1).max(24).default(12),
  /**
   * Which part of a search (D165): the cache, the food databases, or both in
   * one response. Both is the default, so a client that predates the split
   * behaves as it did.
   */
  source: z.enum(["all", "local", "remote"]).default("all"),
});

/* ------------------------------------------------------------ food entries */

export const createFoodEntrySchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  loggedAt: z.string().datetime({ offset: true }).nullish(),
  mealSlot: mealSlotSchema.default("snack"),
  /** Null for a freetext entry with a typed calorie figure. */
  foodItemId: z.string().uuid().nullish(),
  freetext: z.string().trim().max(200).nullish(),
  grams: z.number().min(0).max(10000),
  /**
   * Only for an entry with no `foodItemId`: the user's own estimate. When a food
   * item is given the server computes the energy from it, so a client cannot
   * disagree with the database about what a food contains.
   */
  kcal: z.number().min(0).max(20000).nullish(),
  proteinG: z.number().min(0).max(2000).nullish(),
  carbsG: z.number().min(0).max(2000).nullish(),
  fatG: z.number().min(0).max(2000).nullish(),
  fiberG: z.number().min(0).max(2000).nullish(),
  /** 0-1. Below 1 marks a figure the user estimated rather than looked up. */
  confidence: z.number().min(0).max(1).default(1),
  confirmed: z.boolean().default(true),
  /** Where `localDate` came from (D61). Checked, never stored. */
  dateSource: dateSourceSchema.optional(),
});
export type CreateFoodEntry = z.infer<typeof createFoodEntrySchema>;

/**
 * Correcting a logged entry: the amount, and which meal it belonged to.
 *
 * Amount is the field that is actually got wrong — 250 g typed for 150 — and
 * until now the only way to fix it was to delete the row and enter it again,
 * which loses the time it was logged at. §3 says every user-created row ships
 * with an edit, and a food entry is many-per-day, so re-logging is not one
 * (D56).
 *
 * Deliberately not editable: `foodItemId` and `localDate`. Changing which food
 * a row is makes it a different entry rather than a corrected one, and moving a
 * row to another day is a delete and a re-log with the day's other rows
 * recomputed. Both are better done as what they are.
 */
export const updateFoodEntrySchema = z.object({
  grams: z.number().min(0).max(10000),
  mealSlot: mealSlotSchema.optional(),
});
export type UpdateFoodEntry = z.infer<typeof updateFoodEntrySchema>;

export const foodEntrySchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  localDate: z.string(),
  loggedAt: z.string(),
  mealSlot: mealSlotSchema,
  foodItemId: z.string().uuid().nullable(),
  /** The food's name, resolved for display. Freetext when there is no item. */
  name: z.string(),
  brand: z.string().nullable(),
  grams: z.number(),
  kcal: z.number(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
  fiberG: z.number().nullable(),
  confidence: z.number(),
  confirmed: z.boolean(),
});
export type FoodEntry = z.infer<typeof foodEntrySchema>;

export const foodEntryListSchema = z.object({ entries: z.array(foodEntrySchema) });

/* ---------------------------------------------------------- meal templates */

export const templateItemSchema = z.object({
  foodItemId: z.string().uuid().nullable(),
  /** The name at the time it was added, so a deleted food leaves a readable line (D17). */
  nameSnapshot: z.string(),
  freetext: z.string().nullable(),
  grams: z.number(),
  position: z.number().int(),
});
export type TemplateItem = z.infer<typeof templateItemSchema>;

export const mealTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  defaultMealSlot: mealSlotSchema.nullable(),
  useCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  items: z.array(templateItemSchema),
});
export type MealTemplate = z.infer<typeof mealTemplateSchema>;

export const mealTemplateListSchema = z.object({
  templates: z.array(mealTemplateSchema),
});

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  defaultMealSlot: mealSlotSchema.nullish(),
  items: z
    .array(
      z.object({
        foodItemId: z.string().uuid().nullish(),
        nameSnapshot: z.string().trim().min(1).max(200),
        freetext: z.string().trim().max(200).nullish(),
        grams: z.number().min(0).max(10000),
      }),
    )
    .min(1)
    .max(40),
});
export type CreateTemplate = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = createTemplateSchema.partial();
export type UpdateTemplate = z.infer<typeof updateTemplateSchema>;

/** Applying a template writes one food entry per item, all idempotent. */
export const applyTemplateSchema = z.object({
  localDate: localDateSchema,
  mealSlot: mealSlotSchema.nullish(),
  /** One per item, so a replay of the whole application is still idempotent. */
  clientUuids: z.array(clientUuidSchema).min(1).max(40),
});
export type ApplyTemplate = z.infer<typeof applyTemplateSchema>;

/* ------------------------------------------------- estimates and favourites */

/**
 * A restaurant meal or a takeaway, typed in by the person who ate it (D80).
 *
 * The independent-pizzeria case: no barcode, nothing in any database, and the
 * alternative to letting someone type a figure is the day going unlogged. Kept
 * as a reusable food item because the same pizzeria recurs, and because
 * re-typing it produces a different guess every time.
 */
export const createEstimateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Where it came from, when it has a name worth keeping. */
  brand: z.string().trim().max(120).nullish(),
  /**
   * The whole portion, not a per-100 g figure.
   *
   * Nobody knows what a pizza weighs, and asking for kcal per 100 g of one is
   * asking a question with no answer. The grams are the portion the user says
   * they ate, and the per-100 g figure the cache stores is derived from the
   * pair.
   */
  kcal: z.number().min(1).max(10000),
  grams: z.number().min(1).max(5000),
  proteinG: z.number().min(0).max(1000).nullish(),
  carbsG: z.number().min(0).max(1000).nullish(),
  fatG: z.number().min(0).max(1000).nullish(),
  /** What the figure was based on, kept with the item. */
  basis: z.string().trim().max(300).nullish(),
});
export type CreateEstimate = z.infer<typeof createEstimateSchema>;

export const favouriteSchema = z.object({
  foodItemId: z.string().uuid(),
  favourite: z.boolean(),
});
export type SetFavourite = z.infer<typeof favouriteSchema>;
