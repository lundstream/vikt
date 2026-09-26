import { scaleToGrams } from "../food.js";
import { dayMacros, type MacroTotal } from "./macros.js";

/**
 * A meal's energy and macros, per portion (Phase 14, D186).
 *
 * **The one place this is computed.** The list of meals, the create and edit
 * sheet's running figure and the shared list all call this, so two screens
 * cannot disagree about the same pot. The server returns what this returned;
 * the sheet calls it on the rows being edited before they are saved.
 *
 * It is D55 applied to a dish instead of a day. A macro is the sum of what the
 * priced rows carry, weighted by energy for coverage, and below the gate it is
 * a floor the screen prefixes with "minst". A row whose food is gone (the food
 * was deleted, the row kept its name) has **unknown energy**, which is new
 * here: a day's rows always carry a kcal figure, and a meal's ingredient need
 * not. Such a row makes the energy a floor as well, and every macro with it,
 * because a macro's coverage cannot be judged against energy nobody knows.
 */

/** The per-100 g figures a row is priced from. Null when the food is gone. */
export type MealRowFood = {
  kcalPer100: number;
  proteinPer100: number | null;
  carbsPer100: number | null;
  fatPer100: number | null;
  fiberPer100: number | null;
};

export type MealRow = { grams: number; food: MealRowFood | null };

export type MealNutrition = {
  /** Energy per portion. Null only when no row can be priced at all. */
  kcal: number | null;
  /** False when any row has unknown energy: the figure is then "minst". */
  kcalComplete: boolean;
  protein: MacroTotal;
  carbs: MacroTotal;
  fat: MacroTotal;
  fiber: MacroTotal;
};

/** What one row contributes, or null when its food is gone. */
export function priceMealRow(row: MealRow) {
  if (row.food === null) return null;
  return scaleToGrams(
    {
      kcalPer100: row.food.kcalPer100,
      macros: {
        proteinG: row.food.proteinPer100,
        carbsG: row.food.carbsPer100,
        fatG: row.food.fatPer100,
        fiberG: row.food.fiberPer100,
        saltG: null,
      },
    },
    row.grams,
  );
}

function perPortion(total: MacroTotal, portions: number, allPriced: boolean): MacroTotal {
  return {
    grams: total.grams === null ? null : total.grams / portions,
    coverage: total.coverage,
    complete: total.complete && allPriced,
  };
}

/**
 * The meal divided by its portions.
 *
 * `portions` is the meal's own count, which is never zero (the database says
 * so, and the schema refuses it before it gets there); a non-positive value
 * here is a programming error and is treated as one portion rather than
 * producing an infinity somebody would read as a figure.
 */
export function mealNutrition(rows: readonly MealRow[], portions: number): MealNutrition {
  const divisor = portions > 0 ? portions : 1;
  const priced = rows.map(priceMealRow).filter((row) => row !== null);
  const allPriced = priced.length === rows.length;
  const whole = dayMacros(
    priced.map((row) => ({
      kcal: row.kcal,
      proteinG: row.macros.proteinG,
      carbsG: row.macros.carbsG,
      fatG: row.macros.fatG,
      fiberG: row.macros.fiberG,
    })),
  );

  return {
    kcal: whole.kcal === null ? null : whole.kcal / divisor,
    kcalComplete: whole.kcal !== null && allPriced,
    protein: perPortion(whole.protein, divisor, allPriced),
    carbs: perPortion(whole.carbs, divisor, allPriced),
    fat: perPortion(whole.fat, divisor, allPriced),
    fiber: perPortion(whole.fiber, divisor, allPriced),
  };
}

/**
 * The grams of one ingredient row when `eaten` portions of a meal that makes
 * `makes` are logged, to the tenth of a gram the log stores.
 *
 * 1,5 portions of a four-portion stew is three eighths of every row. Rounded
 * here rather than by the database so the figure the confirmation shows is the
 * figure that is written.
 */
export function gramsForPortions(rowGrams: number, eaten: number, makes: number): number {
  const divisor = makes > 0 ? makes : 1;
  return Math.round(((rowGrams * eaten) / divisor) * 10) / 10;
}
