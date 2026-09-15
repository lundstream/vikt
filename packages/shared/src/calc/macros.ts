/**
 * Macro targets from the Nordic Nutrition Recommendations 2023 (D52).
 *
 * NNR 2023 is the reference Livsmedelsverket publishes for Sweden. It gives
 * macronutrients as **energy percentages**, not as grams, so every figure here
 * is derived from the plan's daily kcal target and moves when that moves.
 *
 * Three properties of the source shape this file more than the arithmetic does:
 *
 *  1. **The values are for groups, not individuals.** NNR says so directly:
 *     reference values cannot be applied to a person without estimating that
 *     person's energy need. The UI says this in a sentence; the code cannot
 *     make it true by being careful.
 *  2. **They refer to average intake over at least a week**, because diet
 *     composition varies meal to meal and day to day. So the comparison is
 *     against a rolling seven-day mean, and a single day shows amounts without
 *     a verdict. A daily bar turning red on an ordinary Tuesday would state
 *     something the source does not.
 *  3. **Protein is not a flat percentage in a deficit.** See `proteinTarget`.
 *
 * Energy factors are NNR's own, not the 4/4/9 shorthand: the shorthand is
 * kcal-per-gram rounded for mental arithmetic, and NNR states its own values in
 * kJ per gram. `food.ts` already treats the kJ/kcal distinction as load-bearing
 * rather than cosmetic, so the conversion comes from there and there is one
 * definition of 4.184 in the codebase.
 *
 * Pure. No I/O, no clock.
 */

import { kcalToKj, type Macros } from "../food.js";

/** NNR 2023 energy factors, kJ per gram. */
export const KJ_PER_G = {
  protein: 17,
  carbs: 17,
  fat: 37,
  /** Fibre is fermented rather than digested, hence the lower figure. */
  fiber: 8,
} as const;

/**
 * Diet-planning targets, as energy percentages, taken from within NNR's
 * recommended bands rather than at their edges.
 *
 * The bands are wider than these (fat 25-40 E%, carbohydrate 45-60 E%); a
 * planning target has to be one number, and the middle of the band is the
 * defensible choice. Carbohydrate includes fibre, as NNR counts it.
 */
export const ENERGY_PERCENT = {
  fat: 0.325,
  carbs: 0.525,
  protein: 0.15,
} as const;

/**
 * Fibre is the one absolute figure in the set: at least 3 g per MJ of intake.
 *
 * Per megajoule, so it scales with the target rather than being a flat 25-35 g
 * that would be proportionally severe on a small intake and slack on a large.
 */
export const FIBER_G_PER_MJ = 3;

/**
 * NNR's recommended protein intake for adults, g per kg body weight per day.
 *
 * The floor in `proteinTarget`. Note that this is the *recommended intake*, not
 * the average requirement, which is lower.
 */
export const PROTEIN_G_PER_KG = 0.83;

/**
 * Below this daily intake NNR notes the protein proportion should be raised.
 * 8 MJ is about 1912 kcal.
 */
export const LOW_ENERGY_MJ = 8;

export type MacroTargets = {
  /** The daily energy target these were derived from, in kcal. */
  targetKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG: number;
  /**
   * Which rule produced the protein figure, so the UI can explain a number that
   * is not simply 15% of the target.
   */
  proteinBasis: "energy_percent" | "per_kg";
  /** True when the target is under 8 MJ, where NNR flags the protein question. */
  belowLowEnergyThreshold: boolean;
};

const round = (value: number) => Math.round(value);

/**
 * Protein in grams: the higher of the energy-percentage figure and NNR's
 * g-per-kg recommendation.
 *
 * This is the constraint that matters most in this app, because this app exists
 * to help people eat less. 15 E% of a weight-loss target yields *fewer* grams
 * exactly when the requirement is least negotiable: protein need scales with
 * body mass, not with how much someone happens to be eating this month. NNR
 * addresses this directly, noting that the proportion should rise as energy
 * intake falls below 8 MJ/day.
 *
 * So both are computed and the larger wins. At 1600 kcal and 90 kg the
 * percentage gives 59 g and the g/kg rule gives 75 g; at 2600 kcal the
 * percentage gives 96 g and wins on its own.
 *
 * `trendWeightKg` is the smoothed weight (D2), not this morning's reading: a
 * protein target that moved with water weight would be noise.
 */
export function proteinTarget(
  targetKcal: number,
  trendWeightKg: number | null,
): { grams: number; basis: MacroTargets["proteinBasis"] } {
  const fromEnergy = (kcalToKj(targetKcal) * ENERGY_PERCENT.protein) / KJ_PER_G.protein;

  if (trendWeightKg === null || !Number.isFinite(trendWeightKg) || trendWeightKg <= 0) {
    return { grams: fromEnergy, basis: "energy_percent" };
  }

  const fromWeight = trendWeightKg * PROTEIN_G_PER_KG;
  return fromWeight > fromEnergy
    ? { grams: fromWeight, basis: "per_kg" }
    : { grams: fromEnergy, basis: "energy_percent" };
}

/**
 * The full set, derived from a daily kcal target and the trend weight.
 *
 * Derived and never stored, so changing the plan changes these on the next
 * read. A stored copy would be a second definition to keep in step, which is
 * the mistake D44 and D47 exist to prevent.
 */
export function macroTargets(input: {
  targetKcal: number;
  trendWeightKg: number | null;
}): MacroTargets | null {
  const { targetKcal, trendWeightKg } = input;
  if (!Number.isFinite(targetKcal) || targetKcal <= 0) return null;

  const kj = kcalToKj(targetKcal);
  const protein = proteinTarget(targetKcal, trendWeightKg);

  return {
    targetKcal,
    proteinG: round(protein.grams),
    carbsG: round((kj * ENERGY_PERCENT.carbs) / KJ_PER_G.carbs),
    fatG: round((kj * ENERGY_PERCENT.fat) / KJ_PER_G.fat),
    fiberG: round((kj / 1000) * FIBER_G_PER_MJ),
    proteinBasis: protein.basis,
    belowLowEnergyThreshold: kj / 1000 < LOW_ENERGY_MJ,
  };
}

/* ------------------------------------------------------ what was eaten */

/**
 * A macro total, and how much of the day's food it actually covers.
 *
 * The hazard this type exists for: crowdsourced food data frequently lacks
 * individual macros, and summing only the entries that have them produces a
 * plausible-looking total that is silently low. That is absent-is-not-zero
 * (D44) in its quietest form, because unlike a missing day the result still
 * looks like an answer.
 *
 * So a total always travels with the fraction of the day's energy it was
 * computed from, and `complete` says whether that fraction is high enough to
 * compare against a target at all.
 */
export type MacroTotal = {
  grams: number | null;
  /** Fraction of the day's kcal that came from entries carrying this macro. */
  coverage: number;
  complete: boolean;
};

/**
 * How much of a day's energy must carry a macro before its total is shown as a
 * figure rather than as a partial one (D55).
 *
 * 0.9 rather than something looser: the number this guards is compared against
 * a target, and a total missing a fifth of the day's food would sit visibly
 * under that target while being wrong rather than low. High enough that a
 * displayed total is worth acting on, low enough that one unlabelled coffee
 * does not invalidate a day.
 */
export const MACRO_COVERAGE_THRESHOLD = 0.9;

/**
 * One logged item. The macro fields are `Macros`' own, so a field renamed there
 * fails here rather than quietly becoming a permanently-null column.
 */
export type MacroEntry = { kcal: number } & Pick<
  Macros,
  "proteinG" | "carbsG" | "fatG" | "fiberG"
>;

export type DayMacros = {
  kcal: number | null;
  protein: MacroTotal;
  carbs: MacroTotal;
  fat: MacroTotal;
  fiber: MacroTotal;
};

function total(
  entries: readonly MacroEntry[],
  pick: (entry: MacroEntry) => number | null,
): MacroTotal {
  const energy = entries.reduce((sum, entry) => sum + Math.max(0, entry.kcal), 0);
  const withMacro = entries.filter((entry) => pick(entry) !== null);

  if (withMacro.length === 0) {
    return { grams: null, coverage: 0, complete: false };
  }

  const covered = withMacro.reduce((sum, entry) => sum + Math.max(0, entry.kcal), 0);
  // An all-zero-kcal day cannot be weighted by energy, so fall back to counting
  // entries rather than dividing by zero.
  const coverage = energy > 0 ? covered / energy : withMacro.length / entries.length;

  return {
    grams: withMacro.reduce((sum, entry) => sum + (pick(entry) ?? 0), 0),
    coverage,
    complete: coverage >= MACRO_COVERAGE_THRESHOLD,
  };
}

/**
 * A day's macros from its entries.
 *
 * Coverage is weighted by **energy**, not by entry count: a day of five
 * labelled snacks and one unlabelled dinner is mostly unknown, and counting
 * entries would call it 83% covered.
 */
export function dayMacros(entries: readonly MacroEntry[]): DayMacros {
  if (entries.length === 0) {
    const empty: MacroTotal = { grams: null, coverage: 0, complete: false };
    return { kcal: null, protein: empty, carbs: empty, fat: empty, fiber: empty };
  }

  return {
    kcal: entries.reduce((sum, entry) => sum + entry.kcal, 0),
    protein: total(entries, (entry) => entry.proteinG),
    carbs: total(entries, (entry) => entry.carbsG),
    fat: total(entries, (entry) => entry.fatG),
    fiber: total(entries, (entry) => entry.fiberG),
  };
}

/* ------------------------------------------------- over several days */

export type MacroName = "protein" | "carbs" | "fat" | "fiber";

/**
 * One macro over a window of days: seven on the dashboard, seven and
 * twenty-eight in the coach's sheet (D55, addendum 2026-09-15).
 */
export type WindowMacroTotal = {
  /**
   * The mean, over the days with anything logged, of each day's **known**
   * grams. Null only when no logged food in the window carries the macro at
   * all, or when nothing was logged.
   */
  meanG: number | null;
  /** Days with anything logged: the denominator. An unlogged day is absent. */
  days: number;
  /** Of those, the days whose own coverage was under the gate. */
  partialDays: number;
  /** 0-1 of the window's logged energy that carried this macro. */
  coverage: number;
  /** Every logged day cleared the gate. False makes `meanG` a floor: "minst". */
  complete: boolean;
};

/**
 * A window's figure is built from its days' known values, and is a floor as
 * soon as any of those days was.
 *
 * Until 2026-09-15 a day under the gate was **left out** of the mean, which
 * meant a week of honest logging from crowdsourced data could show nothing at
 * all for fibre, while every day of it had a known lower bound worth stating.
 * Summing what is known and saying "minst" is true in both directions: the
 * figure is never higher than what was eaten, and never hidden when something
 * is known.
 *
 * A logged day on which no food carried the macro contributes zero grams to
 * that sum and counts as partial, which is still a correct floor. Only when
 * *no* logged food in the whole window carried it is there nothing to say.
 */
export function windowMacroTotal(days: readonly DayMacros[], key: MacroName): WindowMacroTotal {
  const logged = days.filter((day) => day.kcal !== null);
  const carried = logged.some((day) => day[key].grams !== null);

  if (logged.length === 0 || !carried) {
    return { meanG: null, days: logged.length, partialDays: logged.length, coverage: 0, complete: false };
  }

  const energy = logged.reduce((sum, day) => sum + Math.max(0, day.kcal ?? 0), 0);
  const covered = logged.reduce(
    (sum, day) => sum + day[key].coverage * Math.max(0, day.kcal ?? 0),
    0,
  );
  // As in `total`: an all-zero-kcal window cannot be weighted by energy.
  const coverage =
    energy > 0 ? covered / energy : logged.reduce((sum, day) => sum + day[key].coverage, 0) / logged.length;
  const partialDays = logged.filter((day) => !day[key].complete).length;

  return {
    meanG: logged.reduce((sum, day) => sum + (day[key].grams ?? 0), 0) / logged.length,
    days: logged.length,
    partialDays,
    coverage,
    complete: partialDays === 0,
  };
}

/**
 * The seven-day mean of a daily series, which is what NNR's values compare
 * against.
 *
 * Days with nothing logged are **absent, not zero**, and are excluded from the
 * mean rather than dragging it down: the same rule as §4.2's `daysLogged`
 * denominator. `days` counts how many contributed, so the UI can say what the
 * average is actually an average of.
 */
export function weeklyMean(
  values: readonly (number | null)[],
): { mean: number | null; days: number } {
  const logged = values.filter((value): value is number => value !== null);
  if (logged.length === 0) return { mean: null, days: 0 };

  return {
    mean: logged.reduce((sum, value) => sum + value, 0) / logged.length,
    days: logged.length,
  };
}

/** How many days of history the weekly comparison wants before it is shown. */
export const WEEKLY_WINDOW_DAYS = 7;
export const MIN_DAYS_FOR_WEEKLY = 3;
