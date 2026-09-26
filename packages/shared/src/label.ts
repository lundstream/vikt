import { z } from "zod";
import { KJ_PER_KCAL, energyPairAgrees } from "./food.js";
import { PHOTO_MAX_BASE64 } from "./schemas/llm.js";

/**
 * The label photo (Phase 14, D190): the one place a model returns nutrition
 * figures, and the three guards that make it transcription rather than
 * estimation (D5, amended).
 *
 * This file is the first guard. The figures on an EU nutrition declaration are
 * not independent: the energy printed is, within rounding and a few legal
 * tolerances, the sum of the macros times their conversion factors. A figure
 * the model misread moves one side of that sum and not the other, which is
 * what separates "5,6 g" of fibre read as 56 from the 56 g that is really
 * printed on a bag of sugar-free sweets.
 */

/** kcal per gram, Regulation (EU) 1169/2011, Annex XIV. */
export const EU_KCAL_PER_GRAM = {
  protein: 4,
  carbohydrate: 4,
  fat: 9,
  fibre: 2,
  polyols: 2.4,
  alcohol: 7,
} as const;

/**
 * How far the macros may sum from the printed energy, as a fraction of it.
 *
 * 15 %, from the brief. A label rounds every figure (0,1 g, 1 g above ten)
 * and the regulation allows a product's measured values some way either side
 * of what is printed, so an honest label does not sum exactly: the three used
 * to set this land at 1 %, 3 % and 7,5 % (D190). A misread decimal comma moves
 * one figure tenfold and lands far outside it.
 */
export const LABEL_ENERGY_TOLERANCE = 0.15;

/** A figure per 100 g or ml, as printed. Null: not printed, or not readable. */
const figure = z.number().min(0).max(5000).nullable();

/**
 * What the model returns, read strictly. Every figure nullable: absent is not
 * zero (D44), and "not printed" is the commonest honest answer for polyols,
 * fibre and alcohol.
 */
export const labelTranscriptionSchema = z
  .object({
    name: z.string().trim().max(200).nullable(),
    column: z.string().trim().max(60).nullable(),
    basis: z.enum(["100g", "100ml"]).nullable(),
    columns: z.number().int().min(0).max(8),
    energyKj: figure,
    energyKcal: figure,
    fat: figure,
    saturatedFat: figure,
    carbohydrate: figure,
    sugars: figure,
    polyols: figure,
    fibre: figure,
    protein: figure,
    salt: figure,
    alcohol: figure,
    servingSize: z
      .object({ amount: z.number().positive().max(5000), unit: z.enum(["g", "ml"]) })
      .strict()
      .nullable(),
  })
  .strict();
export type LabelTranscription = z.infer<typeof labelTranscriptionSchema>;

/** The figures the check reads, whoever wrote them: the model or the person. */
export type LabelFigures = Pick<
  LabelTranscription,
  "energyKj" | "energyKcal" | "fat" | "carbohydrate" | "polyols" | "fibre" | "protein" | "alcohol"
>;

export type LabelCheck =
  | {
      ok: true;
      /** The energy the macros add up to, kcal per 100. */
      computedKcal: number;
      /** The energy printed, kcal per 100 (from kJ when only kJ is printed). */
      statedKcal: number;
      /** |computed − stated| / stated. */
      deviation: number;
    }
  | {
      ok: false;
      reason:
        | "no_energy"
        | "missing_macros"
        | "energy_pair_disagrees"
        | "sum_disagrees"
        | "polyols_exceed_carbohydrate";
      computedKcal: number | null;
      statedKcal: number | null;
      deviation: number | null;
    };

/** The energy printed, in kcal: the kcal figure, or the kJ figure converted. */
export function statedKcal(figures: Pick<LabelFigures, "energyKj" | "energyKcal">): number | null {
  if (figures.energyKcal !== null && figures.energyKcal > 0) return figures.energyKcal;
  if (figures.energyKj !== null && figures.energyKj > 0) return figures.energyKj / KJ_PER_KCAL;
  return null;
}

/**
 * The energy the figures add up to, with the EU factors.
 *
 * Two facts about an EU label decide the arithmetic, and getting either wrong
 * fails honest labels:
 *
 *  - **Carbohydrate excludes fibre.** Fibre is declared on its own line and
 *    counts at 2 kcal per gram, on top of the carbohydrate.
 *  - **Carbohydrate includes polyols.** The regulation defines carbohydrate as
 *    "any carbohydrate which is metabolised by humans, and includes polyols",
 *    so the polyols line is a *varav* under it. They count at 2,4 inside the
 *    carbohydrate figure, not at 2,4 on top of it: the probe's sugar-free bag
 *    sums to 159 of a printed 164 kcal this way and to 192 the other way,
 *    which would have failed a label that was read correctly.
 *
 * Null when a macro the sum needs is missing. Fat, carbohydrate and protein
 * are mandatory on every EU declaration, so a missing one is a figure the
 * model could not read, not one the label left out; fibre, polyols and
 * alcohol are optional and count as nothing when not printed.
 */
export function computedKcal(figures: LabelFigures): number | null {
  if (figures.fat === null || figures.carbohydrate === null || figures.protein === null) {
    return null;
  }
  const polyols = figures.polyols ?? 0;
  const digestible = Math.max(0, figures.carbohydrate - polyols);
  return (
    figures.protein * EU_KCAL_PER_GRAM.protein +
    figures.fat * EU_KCAL_PER_GRAM.fat +
    digestible * EU_KCAL_PER_GRAM.carbohydrate +
    polyols * EU_KCAL_PER_GRAM.polyols +
    (figures.fibre ?? 0) * EU_KCAL_PER_GRAM.fibre +
    (figures.alcohol ?? 0) * EU_KCAL_PER_GRAM.alcohol
  );
}

/**
 * Whether the figures agree with each other (the first guard, D190).
 *
 * Run by the sheet on every keystroke and by the server before anything is
 * written, so a label that does not add up cannot be saved by a client that
 * skipped the check.
 */
export function checkLabel(figures: LabelFigures): LabelCheck {
  const stated = statedKcal(figures);
  const computed = computedKcal(figures);

  if (stated === null) {
    return { ok: false, reason: "no_energy", computedKcal: computed, statedKcal: null, deviation: null };
  }
  if (energyPairAgrees(figures.energyKcal, figures.energyKj) === false) {
    return { ok: false, reason: "energy_pair_disagrees", computedKcal: computed, statedKcal: stated, deviation: null };
  }
  if (computed === null) {
    return { ok: false, reason: "missing_macros", computedKcal: null, statedKcal: stated, deviation: null };
  }
  if (
    figures.polyols !== null &&
    figures.carbohydrate !== null &&
    figures.polyols > figures.carbohydrate
  ) {
    return {
      ok: false,
      reason: "polyols_exceed_carbohydrate",
      computedKcal: computed,
      statedKcal: stated,
      deviation: Math.abs(computed - stated) / stated,
    };
  }

  const deviation = Math.abs(computed - stated) / stated;
  return deviation <= LABEL_ENERGY_TOLERANCE
    ? { ok: true, computedKcal: computed, statedKcal: stated, deviation }
    : { ok: false, reason: "sum_disagrees", computedKcal: computed, statedKcal: stated, deviation };
}

/* ------------------------------------------------------------ the requests */

export const readLabelRequestSchema = z.object({
  image: z.string().min(32).max(PHOTO_MAX_BASE64),
});
export type ReadLabelRequest = z.infer<typeof readLabelRequestSchema>;

export const readLabelResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    label: labelTranscriptionSchema,
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
    retryAfterSeconds: z.number().int().min(1).optional(),
  }),
]);
export type ReadLabelResponse = z.infer<typeof readLabelResponseSchema>;

/**
 * Saving a transcription the person has confirmed, figure by figure (the
 * second guard), as an ordinary food of their own (the third).
 */
export const createLabelFoodSchema = z.object({
  name: z.string().trim().min(1).max(200),
  basis: z.enum(["100g", "100ml"]),
  energyKj: figure,
  energyKcal: figure,
  fat: z.number().min(0).max(100),
  saturatedFat: figure,
  carbohydrate: z.number().min(0).max(100),
  sugars: figure,
  polyols: figure,
  fibre: figure,
  protein: z.number().min(0).max(100),
  salt: figure,
  alcohol: figure,
  servingSize: z
    .object({ amount: z.number().positive().max(5000), unit: z.enum(["g", "ml"]) })
    .nullable(),
  /** The scan that found nothing, so the next scan of it finds this. */
  barcode: z
    .string()
    .trim()
    .regex(/^\d{6,14}$/)
    .nullable(),
});
export type CreateLabelFood = z.infer<typeof createLabelFoodSchema>;
