import { z } from "zod";
import type { ChatMessage } from "./client.js";

/**
 * The one place the model is allowed to produce a number (D81).
 *
 * D5 is the rule this bends, and it is worth restating exactly: *the model
 * never produces nutrition numbers, because a model that confidently invents
 * plausible ones would poison the intake series.* That still holds everywhere
 * else, and everywhere else is almost everything — parsing a sentence, building
 * a recipe, decomposing a plate all resolve to `food_items` and always will.
 *
 * The exception exists because for a named chain burger or a pizzeria pizza the
 * alternative is not a database figure. It is **the user guessing**, and people
 * systematically underestimate restaurant portions, so refusing to estimate does
 * not avoid an invented number, it just moves the invention somewhere less
 * examined and biases it downwards.
 *
 * So the estimate is hedged everywhere it can be:
 *
 *  - it is only reachable when decomposition has already failed or been
 *    rejected, and only when the user asks for it in as many words;
 *  - it arrives as a **proposal**, editable, with what it was based on written
 *    next to it, and is written only when accepted;
 *  - it is stored with `source: "llm_estimate"`, `confidence < 1` and
 *    `confirmed: false` until the person accepts it;
 *  - and §4.2's maintenance figure knows how much of its window came from
 *    estimates (D82).
 *
 * The model is asked for a *range* as well as a point figure, because the width
 * of the range is the honest part: a burger it recognises is 550 to 700 kcal
 * and a dish it does not is 400 to 1200, and a person can act on that
 * difference.
 */

export const ESTIMATE_SYSTEM_PROMPT = `Du uppskattar energi och makron för en maträtt som inte finns i någon livsmedelsdatabas.

Svara ENDAST med JSON i exakt den här formen:
{"kcal":780,"kcalLow":650,"kcalHigh":950,"proteinG":38,"carbsG":62,"fatG":40,"grams":420,"basis":"Ungefär en dubbelburgare med bröd, ost, dressing och en portion pommes."}

Regler:
- kcal: hela portionen, inte per 100 gram.
- kcalLow och kcalHigh: hur brett du faktiskt är osäker. Känner du rätten väl ska intervallet vara smalt, annars brett. Ljug inte om säkerheten.
- grams: ungefärlig portionsvikt.
- basis: en mening om vad du utgick ifrån, på svenska. Det är den användaren bedömer siffran på.
- Är rätten en kedjas namngivna produkt, utgå från kedjans egen portion.
- Hittar du på: säg hellre ett brett intervall än en exakt siffra du inte har täckning för.`;

export function estimateMessages(dish: string): ChatMessage[] {
  return [
    { role: "system", content: ESTIMATE_SYSTEM_PROMPT },
    { role: "user", content: dish },
  ];
}

/**
 * The estimate's shape.
 *
 * `.strict()` like every other model reply, and the bounds are checked rather
 * than trusted: a "range" whose low is above its high, or whose point figure
 * sits outside it, is a model that has not understood the question, and its
 * number is not worth more than its arithmetic.
 */
export const dishEstimateSchema = z
  .object({
    kcal: z.number().min(1).max(10000),
    kcalLow: z.number().min(0).max(10000),
    kcalHigh: z.number().min(1).max(20000),
    proteinG: z.number().min(0).max(500).nullish(),
    carbsG: z.number().min(0).max(1000).nullish(),
    fatG: z.number().min(0).max(500).nullish(),
    grams: z.number().min(1).max(5000),
    basis: z.string().trim().min(1).max(300),
  })
  .strict()
  .refine((e) => e.kcalLow <= e.kcal && e.kcal <= e.kcalHigh, {
    message: "the point estimate must sit inside its own range",
  });

export type DishEstimate = z.infer<typeof dishEstimateSchema>;

export type EstimateOutcome =
  | { ok: true; estimate: DishEstimate; confidence: number }
  | { ok: false; reason: "unusable_output"; detail: string };

/**
 * How much to trust it, from how wide the model said it was.
 *
 * Derived from the range rather than asked for, because a model asked "how
 * confident are you" answers with a number about its tone. The width of an
 * interval it has to commit to is a claim it can be held to, and it is the one
 * the user sees.
 *
 * Never 1. `confirmed` and `confidence` are the two columns phase 3 already
 * uses to mark an entry as less than certain, and an estimate is by
 * construction less than certain no matter how sure the model sounds.
 */
export const MAX_ESTIMATE_CONFIDENCE = 0.8;
export const MIN_ESTIMATE_CONFIDENCE = 0.3;

export function confidenceFromRange(estimate: DishEstimate): number {
  const width = estimate.kcalHigh - estimate.kcalLow;
  if (!Number.isFinite(width) || estimate.kcal <= 0) return MIN_ESTIMATE_CONFIDENCE;

  // A range half as wide as the estimate itself is about as vague as a usable
  // answer gets; anything wider bottoms out rather than going negative.
  const relative = Math.min(1, width / estimate.kcal / 0.5);
  const confidence =
    MAX_ESTIMATE_CONFIDENCE - relative * (MAX_ESTIMATE_CONFIDENCE - MIN_ESTIMATE_CONFIDENCE);

  return Math.round(confidence * 100) / 100;
}

export function readDishEstimate(content: string): EstimateOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, reason: "unusable_output", detail: "not JSON" };
  }

  const parsed = dishEstimateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: parsed.error.issues[0]?.message ?? "wrong shape",
    };
  }

  return { ok: true, estimate: parsed.data, confidence: confidenceFromRange(parsed.data) };
}
