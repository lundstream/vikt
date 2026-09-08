/**
 * Food data: energy units, missing values, and normalisation to per-100 g.
 *
 * Two hazards live here, both of which silently poison the intake series that
 * adaptive TDEE is computed from (§4.2).
 *
 * **Energy units.** European product data commonly carries kilojoules. Reading
 * kJ as kcal understates a food by a factor of 4.184 — a 2000 kJ ready meal
 * logged as 2000 kcal, or the reverse, and the daily total is wrong by
 * hundreds. So the source unit is stored explicitly and converted here, and a
 * product whose unit cannot be determined is **refused**, not guessed.
 *
 * **Missing values.** Crowdsourced data is frequently incomplete. A missing
 * macro is *absent*, exactly as an unlogged day is absent rather than zero
 * (calc/intake.ts). Zero would make a food look like a free food and drag every
 * total it appears in downwards.
 */

/** kcal per kilojoule. The thermochemical calorie, which is what food labels use. */
export const KJ_PER_KCAL = 4.184;

export type EnergyUnit = "kcal" | "kJ";

export function kjToKcal(kj: number): number {
  return kj / KJ_PER_KCAL;
}

export function kcalToKj(kcal: number): number {
  return kcal * KJ_PER_KCAL;
}

/**
 * Converts an energy value to kcal, or returns null when the unit is unknown.
 *
 * Deliberately not defaulting to kcal. A source that does not say what its
 * numbers mean is a source we cannot import, and the whole point of this
 * function is to make that a returned `null` rather than a plausible number.
 */
export function toKcal(value: number, unit: EnergyUnit | null | undefined): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (unit === "kcal") return value;
  if (unit === "kJ") return kjToKcal(value);
  return null;
}

/**
 * Guesses nothing, but *notices* when a pair of values is self-consistent.
 *
 * Open Food Facts often carries both `energy-kcal_100g` and `energy-kj_100g`. If
 * the two agree to within a few percent the unit labelling is trustworthy; if
 * they do not, something is wrong with the record and it should not be trusted
 * silently. Returns null when there is nothing to compare.
 */
export function energyPairAgrees(
  kcal: number | null | undefined,
  kj: number | null | undefined,
  tolerance = 0.05,
): boolean | null {
  if (kcal == null || kj == null) return null;
  if (!Number.isFinite(kcal) || !Number.isFinite(kj) || kcal <= 0 || kj <= 0) return null;
  return Math.abs(kjToKcal(kj) / kcal - 1) <= tolerance;
}

/** Macros per 100 g. Every one is nullable: absent is not zero. */
export type Macros = {
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
  fiberG: number | null;
  saltG: number | null;
};

export const EMPTY_MACROS: Macros = {
  proteinG: null,
  carbsG: null,
  fatG: null,
  fiberG: null,
  saltG: null,
};

/**
 * A number from an external source.
 *
 * Anything that is not a finite, non-negative number becomes `null`. That
 * includes the empty string, `"unknown"`, and the negative values that turn up
 * in crowdsourced data — all of which `Number()` would turn into something.
 */
export function optionalAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** A food normalised to this app's shape, before it is written to `food_items`. */
export type NormalisedFood = {
  source: "openfoodfacts" | "livsmedelsverket" | "manual" | "llm_estimate";
  /** Barcode, Livsmedelsverket id, or null. */
  sourceRef: string | null;
  barcode: string | null;
  name: string;
  brand: string | null;
  /** Always kcal per 100 g, converted from whatever the source used. */
  kcalPer100: number;
  /** What the source actually said, kept so a conversion can be re-checked. */
  sourceEnergyUnit: EnergyUnit;
  macros: Macros;
  servingHints: Record<string, number> | null;
  /** Which household-measure table applies (D85). Null means none does. */
  category?: string | null;
};

export type NormaliseFailure = {
  /** Machine-readable, so the UI can tell "no data" from "bad data". */
  reason: "no_energy" | "unknown_energy_unit" | "inconsistent_energy" | "no_name";
  /** Swedish, like every other message the API produces (D21). */
  message: string;
};

export type NormaliseResult =
  | { ok: true; food: NormalisedFood }
  | { ok: false; failure: NormaliseFailure };

export const NORMALISE_MESSAGES: Record<NormaliseFailure["reason"], string> = {
  no_energy:
    "Produkten saknar energivärde. Skriv in kalorierna själv så sparas de som en uppskattning.",
  unknown_energy_unit:
    "Produktens energivärde saknar enhet, så det går inte att avgöra om det är kcal eller kJ. Skriv in kalorierna själv.",
  inconsistent_energy:
    "Produktens kcal- och kJ-värden stämmer inte överens, så uppgifterna går inte att lita på. Skriv in kalorierna själv.",
  no_name: "Produkten saknar namn i källan.",
};

export function normaliseFailure(reason: NormaliseFailure["reason"]): NormaliseResult {
  return { ok: false, failure: { reason, message: NORMALISE_MESSAGES[reason] } };
}

/**
 * Scales a food to a portion. Absent macros stay absent — a food with unknown
 * protein contributes unknown protein, not zero grams of it.
 */
export function scaleToGrams(
  food: Pick<NormalisedFood, "kcalPer100" | "macros">,
  grams: number,
): { kcal: number; macros: Macros } {
  const factor = grams / 100;
  const scale = (value: number | null) => (value === null ? null : value * factor);

  return {
    kcal: food.kcalPer100 * factor,
    macros: {
      proteinG: scale(food.macros.proteinG),
      carbsG: scale(food.macros.carbsG),
      fatG: scale(food.macros.fatG),
      fiberG: scale(food.macros.fiberG),
      saltG: scale(food.macros.saltG),
    },
  };
}
