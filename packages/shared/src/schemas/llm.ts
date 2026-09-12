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
   *
   * **Null means nobody knows yet** (D143). Only the photo path produces it: a
   * model that answered "stor mängd" has not given an amount, and the app's
   * options are to invent one or to say so. It says so, the field is empty on
   * screen, and the row cannot be saved until a person fills it in. The text
   * path never produces null, because a sentence that states no amount still
   * gives the model something to estimate from and a photograph does not.
   */
  estimatedGrams: z.number().nullable(),
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
      /**
       * Computed from the item and the grams, by the server.
       *
       * Null when the grams are null: the database knows what this food is
       * worth per hundred grams and nobody knows how many grams there are, so
       * there is no figure to state. The screen shows the food and an empty
       * amount rather than a number that quietly assumed one (D143).
       */
      kcal: z.number().nullable(),
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

/* ------------------------------------------------------------- photographs */

/**
 * The largest photograph the server will accept, after the client has resized
 * it.
 *
 * The client reduces to 1280 px on the long edge and re-encodes as JPEG at
 * about 0.8, which turned the phone's own 3 to 11 MB files into 77 to 211 kB
 * when this was measured. Two megabytes is therefore an order of magnitude
 * above anything the resize actually produces: it is the boundary that catches
 * a client which did not resize at all, not a budget anybody is meant to spend.
 */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The long edge the client resizes to, and the JPEG quality it re-encodes at.
 *
 * Here rather than in the web app because they are the measurement the rest of
 * this depends on, not a rendering preference. The 10 to 20 second wait quoted
 * on screen, the vision timeout on the server and the byte ceiling above were
 * all measured at 1280 px and quality 0.8; changing either without re-measuring
 * makes all three wrong at once, and a reader who finds one of them should be
 * able to find the others in the same place.
 */
export const PHOTO_MAX_EDGE = 1280;
export const PHOTO_QUALITY = 0.8;

/**
 * The confidence every row from a photograph carries (D55, D143).
 *
 * A fixed figure rather than a computed one, and below anything the text path
 * produces, because the uncertainty is not in any one row: it is in the fact
 * that a model looked at a picture. D55's estimates lower confidence rather
 * than excluding themselves from the arithmetic, and these do the same. The
 * macro coverage still counts them, because the database is what priced them.
 */
export const PHOTO_CONFIDENCE = 0.6;

/**
 * The same limit expressed in base64 characters, which is what the schema can
 * actually count.
 *
 * Base64 is four characters per three bytes, so the ceiling is the byte limit
 * times four thirds, rounded up to the next quantum of four. Checked here as
 * well as by the route's own body limit, because the two say different things:
 * the body limit refuses to read an oversized request at all, and this refuses
 * an oversized *image* inside a request that was small enough to read.
 */
export const PHOTO_MAX_BASE64 = Math.ceil(PHOTO_MAX_BYTES / 3) * 4;

/**
 * A photograph of a plate, and optionally a few words beside it.
 *
 * `image` is raw base64 with no data URL prefix: the prefix carries a media
 * type the server would have to either trust or re-derive, and re-deriving it
 * from the bytes is the only honest option, so the prefix is stripped by the
 * client rather than sent and ignored.
 *
 * `note` is the line the photograph cannot say. The probe found that a kebab
 * pizza comes back as "Pizza (1 st)" — the picture shows one round thing, and
 * what is on it is the part a person knows. Four words fix it, and they travel
 * with the image into the *same* call, not a second one.
 */
/**
 * One food the model found in a photograph.
 *
 * Two fields, and the shortness is the design. The text parser's item carries
 * an `estimatedGrams` the model guessed and a `confidence` it asserted; neither
 * belongs here. A photograph gives no ground truth to guess grams from — the
 * probe's models said "stor mängd" and "spridd över delar", which are
 * descriptions of a picture — and a confidence figure attached by the thing
 * being judged is not evidence. The app sets the confidence, from the fact that
 * this came from a photograph at all.
 *
 * `amount` is **nullable and stays null**. An amount is a number with a unit
 * the app can turn into grams; anything else is not an amount, and the correct
 * thing to do with "stor mängd" is to show the food with an empty amount field,
 * not to invent 150 g behind the person's back. See `HOUSEHOLD_UNITS`.
 */
export const parsedPhotoItemSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /**
     * `.catch(null)` rather than a rejection, and this is the one place in the
     * codebase where a malformed field is tolerated instead of refused.
     *
     * The reason is what the malformed value actually is. The home plate came
     * back with `"amount": "stor mängd"` — a string where an object belongs —
     * beside three foods the model had named correctly. Refusing the reply
     * would throw those three away over one side dish nobody could quantify,
     * and "no amount" is already a first-class answer here with a defined
     * behaviour on screen. A nutrition key is still refused outright, because
     * that one is a claim rather than an absence.
     */
    amount: z
      .object({ count: z.number().positive().max(2000), unit: z.string().trim().min(1).max(30) })
      .strict()
      .nullish()
      .catch(null),
  })
  .strict();
export type ParsedPhotoItem = z.infer<typeof parsedPhotoItemSchema>;

export const parsedPhotoSchema = z
  .object({ items: z.array(parsedPhotoItemSchema).max(30) })
  .strict();

export const parseFoodPhotoRequestSchema = z.object({
  image: z.string().min(32).max(PHOTO_MAX_BASE64),
  note: z.string().trim().max(200).optional(),
});
export type ParseFoodPhotoRequest = z.infer<typeof parseFoodPhotoRequestSchema>;

/**
 * The answer, with the same two-branch shape as the text parse.
 *
 * The unavailable branch carries two reasons the text path has no use for.
 * `not_configured` is an installation with no vision model named, which is a
 * choice rather than a fault; `rate_limited` is the one place a photo is
 * refused for being one too many, and it shares the coach's allowance because
 * both queue on the same single GPU.
 */
export const parsePhotoResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    items: z.array(foodMatchSchema),
    model: z.string(),
    ms: z.number().int().min(0),
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum([
      "disabled",
      "not_configured",
      "unreachable",
      "timeout",
      "failed",
      "unusable_output",
      "rate_limited",
    ]),
    /** Seconds, and only on `rate_limited`. */
    retryAfterSeconds: z.number().int().min(1).optional(),
  }),
]);
export type ParsePhotoResponse = z.infer<typeof parsePhotoResponseSchema>;

/** What the client asks before offering any of this in the UI. */
export const llmHealthSchema = z.object({
  /** Configured at all. False means the operator has not set a host. */
  configured: z.boolean(),
  /** Answered just now. False means the box is off, which is expected. */
  reachable: z.boolean(),
  models: z.object({ small: z.string(), large: z.string() }),
  /**
   * Whether the photo path may be offered (D143).
   *
   * Its own field rather than a model name, because the question the client is
   * asking is not "which tag is configured" but "has this installation proved
   * that tag can see". False covers every way the answer can be no: the layer
   * is off, no model is named, the boot check has not run, it could not reach
   * the workstation, or the model answered without looking. The surface is
   * absent in all five, which is the same thing every other optional mode does.
   */
  vision: z.boolean(),
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
  /**
   * How sure the saved rows are, for the whole batch (D143).
   *
   * One figure rather than one per row, because the uncertainty is not in any
   * particular row: it is in where the batch came from. A photograph makes
   * every row on it an estimate in the D55 sense — the food was named by a
   * model looking at a picture — and an estimate lowers confidence rather than
   * excluding itself from the arithmetic. The coverage still counts these,
   * because the database is what priced them.
   *
   * Defaults to 1, which is what a typed sentence a person then corrected is
   * worth, and what every caller before this sent.
   */
  confidence: z.number().gt(0).max(1).default(1),
});
export type ConfirmParsed = z.infer<typeof confirmParsedSchema>;
/**
 * What a caller has to send, which is not what the server ends up with:
 * `confidence` has a default, so it is optional on the way in and always
 * present on the way out. The client types against this one.
 */
export type ConfirmParsedInput = z.input<typeof confirmParsedSchema>;

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
