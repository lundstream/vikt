import { z } from "zod";
import { localDateSchema, clientUuidSchema } from "./log.js";
import { mealSlotSchema } from "./food.js";
import { portionSourceSchema, statedPortionSchema } from "./portions.js";

/**
 * The optional LLM layer (§6 phase 8).
 *
 * Every shape here carries the same premise: **the model names things, the
 * database knows what they contain.** §6 states it as a rule for the parser and
 * repeats it for the recipe generator, and it is the single most important
 * constraint in the phase, because a language model asked for calories will
 * produce plausible ones indefinitely and there is no way to tell from the
 * number which is which.
 *
 * So it is enforced here rather than asked for in a prompt. `.strict()` makes
 * an unexpected key a parse failure, and `FORBIDDEN_KEYS` names the specific
 * ones a model reaches for when it decides to be helpful. A prompt is a
 * request; a schema is the thing that holds when the request is ignored.
 */

/**
 * Fields the model must never produce.
 *
 * Checked explicitly as well as by `.strict()`, because a later change that
 * loosens the object — adding an optional passthrough, say — would quietly
 * re-admit them, and this is the rule least likely to be re-derived from first
 * principles by whoever makes that change.
 */
export const FORBIDDEN_MODEL_KEYS = [
  "kcal",
  "calories",
  "kalorier",
  "energy",
  "energi",
  "protein",
  "proteing",
  "carbs",
  "carbohydrates",
  "kolhydrater",
  "fat",
  "fett",
  "fiber",
  "salt",
  "macros",
  "nutrition",
  "naringsvarde",
] as const;

/**
 * One food the model found in a sentence.
 *
 * `estimatedGrams` is the one number it is allowed to produce, and it is an
 * estimate of *portion*, not of nutrition: how much bread, not how much energy.
 * The distinction is the whole design. It is also the number the user is shown
 * and invited to correct before anything is saved.
 */
export const parsedFoodItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    estimatedGrams: z.number().min(0).max(5000),
    /**
     * The portion as stated, when the text stated one.
     *
     * "fem tunna skivor" gives `{count: 5, unit: "skivor"}`, and the count is
     * the half that is actually known: the app can look up what one skiva of
     * this ham weighs, and the model cannot. Where a hint exists the grams come
     * from the hint multiplied by the count, and `estimatedGrams` is ignored.
     *
     * Nullable because plenty of text states no portion at all, and inventing
     * one would be worse than admitting the figure is an estimate.
     */
    portion: z
      .object({ count: z.number().positive().max(200), unit: z.string().trim().min(1).max(30) })
      .strict()
      .nullish(),
    /** The model's own confidence, shown to the user, used in no arithmetic. */
    confidence: z.number().min(0).max(1),
  })
  .strict();

export type ParsedFoodItem = z.infer<typeof parsedFoodItemSchema>;

export const parsedFoodSchema = z
  .object({ items: z.array(parsedFoodItemSchema).max(30) })
  .strict();

/**
 * One parsed item after the database has been consulted.
 *
 * The nutrition comes from `food_items` and only from there. `match` is null
 * when nothing was found, which is a normal outcome and not an error: the user
 * gets the name back with no numbers attached and can search for it themselves.
 */
export const foodMatchSchema = z.object({
  /** What the model called it. */
  name: z.string(),
  /**
   * The grams to save, after the hints have had their say.
   *
   * Named `estimatedGrams` since phase 8 shipped and kept for that reason, but
   * it is no longer always an estimate: `portionSource` says which it is, and
   * every screen showing the number shows that too.
   */
  estimatedGrams: z.number(),
  /** The portion as stated, for display. Never a claim about mass. */
  portion: statedPortionSchema.nullable(),
  /** `hint`, `user_hint` or `estimate`. See {@link portionSourceSchema}. */
  portionSource: portionSourceSchema,
  confidence: z.number(),
  match: z
    .object({
      foodItemId: z.string().uuid(),
      name: z.string(),
      brand: z.string().nullable(),
      kcalPer100: z.number(),
      /** Computed from the item and the grams, by the server. */
      kcal: z.number(),
      /**
       * What this food can be counted in, source hints merged under the user's
       * own. Travels to the client so a portion picker does not need a second
       * request per row.
       */
      servingHints: z.record(z.number()).nullable(),
    })
    .nullable(),
});
export type FoodMatch = z.infer<typeof foodMatchSchema>;

export const parseFoodRequestSchema = z.object({
  text: z.string().trim().min(2).max(500),
});
export type ParseFoodRequest = z.infer<typeof parseFoodRequestSchema>;

/**
 * The answer, including the answer "not available".
 *
 * A discriminated result carried on a **200**, not an error status. The layer
 * is optional by design and its absence is an ordinary state of the world; a
 * 503 would make every client treat a switched-off workstation as a fault, and
 * §6 says the degradation carries no error banner.
 */
export const parseFoodResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    items: z.array(foodMatchSchema),
    model: z.string(),
    ms: z.number().int().min(0),
  }),
  z.object({
    available: z.literal(false),
    /** For the queue inspector and the logs. Never rendered as an error. */
    reason: z.enum(["disabled", "unreachable", "timeout", "failed", "unusable_output"]),
  }),
]);
export type ParseFoodResponse = z.infer<typeof parseFoodResponseSchema>;

/** What the client asks before offering any of this in the UI. */
export const llmHealthSchema = z.object({
  /** Configured at all. False means the operator has not set a host. */
  configured: z.boolean(),
  /** Answered just now. False means the box is off, which is expected. */
  reachable: z.boolean(),
  models: z.object({ small: z.string(), large: z.string() }),
});
export type LlmHealth = z.infer<typeof llmHealthSchema>;

/**
 * Confirming a parse: the rows the user actually accepted, after correcting
 * portions.
 *
 * Nothing is written until this arrives. The parse endpoint reads the database
 * and writes nothing, which is what makes an uncertain match harmless.
 */
export const confirmParsedSchema = z.object({
  localDate: localDateSchema,
  mealSlot: mealSlotSchema.default("snack"),
  items: z
    .array(
      z.object({
        clientUuid: clientUuidSchema,
        /** Null keeps it as freetext, priced by `kcal` below. */
        foodItemId: z.string().uuid().nullable(),
        name: z.string().trim().min(1).max(200),
        grams: z.number().min(0).max(10000),
        /**
         * What an unmatched row is worth, stated by the user (D74).
         *
         * Required when `foodItemId` is null, and the route enforces it.
         * Sending an unpriced row used to write a zero-energy entry, which put
         * a silently low day into the series TDEE is computed from — the
         * absent-is-not-zero rule broken at the one point where the app is
         * doing the writing. Zero is still allowed; it just has to be
         * *chosen*, which is what marking something negligible does.
         */
        kcal: z.number().min(0).max(10000).nullish(),
      }),
    )
    .min(1)
    .max(30),
});
export type ConfirmParsed = z.infer<typeof confirmParsedSchema>;

/* ----------------------------------------------------------------- recipes */

/**
 * What is left of the day, as the recipe generator is told it.
 *
 * Every figure is nullable, and the nullability is the point. There is no
 * remaining anything without a plan to remain against, and a macro whose day is
 * only partly labelled has a *floor* rather than a total (D55) — so what is
 * left is "at most this much", which is a different claim and is marked as one.
 */
export const recipeBudgetSchema = z.object({
  kcal: z.number().nullable(),
  proteinG: z.number().nullable(),
  carbsG: z.number().nullable(),
  fatG: z.number().nullable(),
  /**
   * True when part of the day's food carries no macro data, so the consumed
   * figures are floors and the remaining ones are upper bounds.
   */
  approximate: z.boolean(),
});
export type RecipeBudget = z.infer<typeof recipeBudgetSchema>;

/**
 * The model's recipe, before the database has priced it.
 *
 * `items` is deliberately the **same shape** as the parser's, because §6 says
 * the output goes through the same parse-and-match path: the recipe's nutrition
 * comes from `food_items`, exactly as a typed sentence's does. One pipeline,
 * one place where a model could have smuggled a number in, one place that
 * refuses it.
 */
export const generatedRecipeSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    steps: z.array(z.string().trim().min(1).max(400)).min(1).max(15),
    items: z.array(parsedFoodItemSchema).min(1).max(30),
  })
  .strict();

export const recipeRequestSchema = z.object({
  localDate: localDateSchema,
  /** What is in the fridge, in the user's own words. */
  have: z.string().trim().min(2).max(600),
});
export type RecipeRequest = z.infer<typeof recipeRequestSchema>;

/**
 * A recipe's energy, and whether it is the whole of it.
 *
 * **An incomplete total is not a total** (D74). Summing the matched rows and
 * showing the result as a figure, with a note underneath about what is missing,
 * is absent-is-not-zero (D44) in the quietest form there is: the number looks
 * like an answer, it is understated, and the footnote is set in the size the
 * eye skips. Taco sauce at 30 g is about 50 kcal, and a headline reading
 * "358 kcal" when the truth is "at least 358" is a wrong number presented as a
 * fact.
 *
 * So the flag travels with the figure and the names travel with the flag, and
 * the screen renders "minst" rather than a total whenever `complete` is false.
 */
export const recipeTotalSchema = z.object({
  /** Summed over priced rows only. Null when nothing could be priced at all. */
  kcal: z.number().nullable(),
  /** True only when every ingredient contributed a figure. */
  complete: z.boolean(),
  /** The ingredients not in the sum, by name, for saying so at full size. */
  missing: z.array(z.string()),
});
export type RecipeTotal = z.infer<typeof recipeTotalSchema>;

export const recipeResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    title: z.string(),
    steps: z.array(z.string()),
    /** Priced from the database, never by the model. */
    items: z.array(foodMatchSchema),
    /** What the model was told was left, so the user can see the constraint. */
    budget: recipeBudgetSchema,
    /** The recipe's own energy, and whether it is all of it. */
    total: recipeTotalSchema,
    model: z.string(),
    ms: z.number().int().min(0),
  }),
  z.object({
    available: z.literal(false),
    /**
     * `incomplete_recipe` is the completeness validator refusing twice (D74):
     * an oven step with no temperature, an ingredient no step uses, or a recipe
     * that stops before the food is cooked. Reported like every other
     * unavailability, because a broken recipe and a switched-off box are the
     * same thing from the kitchen.
     */
    reason: z.enum([
      "disabled",
      "unreachable",
      "timeout",
      "failed",
      "unusable_output",
      "incomplete_recipe",
    ]),
  }),
]);
export type RecipeResponse = z.infer<typeof recipeResponseSchema>;

/* ------------------------------------------- the narrow estimate exception */

/**
 * Asking the model what a dish is worth (D81).
 *
 * Every field here is a **precondition**, not a preference. D5 forbids the
 * model producing nutrition numbers; this is the one exception, and it is only
 * an exception while all of its conditions hold, so they travel with the
 * request rather than being assumed by the handler.
 */
export const estimateDishSchema = z.object({
  /** What was eaten, in the user's words. Also stored as the estimate's basis. */
  dish: z.string().trim().min(3).max(300),
  /**
   * What happened when the app tried to do this properly.
   *
   * `not_found` is the search half: nothing by barcode and nothing by name.
   * `decomposed_empty` and `decomposed_rejected` are the parse half — the dish
   * was broken into components and either produced nothing sensible or the user
   * looked at it and said no. Without one of these the exception does not
   * apply, and the endpoint refuses.
   */
  after: z.enum(["not_found", "decomposed_empty", "decomposed_rejected"]),
  /**
   * The user asking, in as many words.
   *
   * Structural rather than decorative: nothing in the app sets this on the
   * user's behalf, and a client that hard-coded it would be doing so visibly.
   */
  requested: z.literal(true),
});
export type EstimateDishRequest = z.infer<typeof estimateDishSchema>;

export const estimateResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    kcal: z.number(),
    /** The honest part: how wide the model had to be to be truthful. */
    kcalLow: z.number(),
    kcalHigh: z.number(),
    proteinG: z.number().nullable(),
    carbsG: z.number().nullable(),
    fatG: z.number().nullable(),
    grams: z.number(),
    /** What it was based on, shown so the figure can be judged. */
    basis: z.string(),
    /** Derived from the range. Never 1: an estimate is not a measurement. */
    confidence: z.number(),
    model: z.string(),
    ms: z.number().int().min(0),
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum(["disabled", "unreachable", "timeout", "failed", "unusable_output"]),
  }),
]);
export type EstimateResponse = z.infer<typeof estimateResponseSchema>;
