import { describe, expect, it } from "vitest";
import { MACRO_COVERAGE_THRESHOLD } from "./macros.js";
import { gramsForPortions, mealNutrition, type MealRow } from "./meals.js";

const oats = {
  kcalPer100: 370,
  proteinPer100: 13,
  carbsPer100: 60,
  fatPer100: 7,
  fiberPer100: 10,
};
const milk = { kcalPer100: 40, proteinPer100: 3.5, carbsPer100: 5, fatPer100: 0.5, fiberPer100: null };

describe("mealNutrition", () => {
  it("divides the whole meal by its portions", () => {
    const rows: MealRow[] = [
      { grams: 200, food: oats },
      { grams: 400, food: { ...milk, fiberPer100: 0 } },
    ];
    const one = mealNutrition(rows, 1);
    const four = mealNutrition(rows, 4);

    expect(one.kcal).toBeCloseTo(740 + 160);
    expect(four.kcal).toBeCloseTo((740 + 160) / 4);
    expect(four.protein.grams).toBeCloseTo((26 + 14) / 4);
    expect(four.protein.complete).toBe(true);
    expect(four.kcalComplete).toBe(true);
  });

  it("says minst below the gate, with the coverage the day would have (D55)", () => {
    // Milk carries no fibre and is 160 of 900 kcal: 82 % covered.
    const rows: MealRow[] = [
      { grams: 200, food: oats },
      { grams: 400, food: milk },
    ];
    const meal = mealNutrition(rows, 2);

    expect(meal.fiber.coverage).toBeCloseTo(740 / 900);
    expect(meal.fiber.coverage).toBeLessThan(MACRO_COVERAGE_THRESHOLD);
    expect(meal.fiber.complete).toBe(false);
    expect(meal.fiber.grams).toBeCloseTo(20 / 2);
  });

  it("makes the energy and every macro a floor when a row's food is gone", () => {
    const rows: MealRow[] = [
      { grams: 200, food: oats },
      { grams: 30, food: null },
    ];
    const meal = mealNutrition(rows, 1);

    expect(meal.kcal).toBeCloseTo(740);
    expect(meal.kcalComplete).toBe(false);
    expect(meal.protein.complete).toBe(false);
    expect(meal.protein.coverage).toBe(1);
  });

  it("knows nothing when no row can be priced", () => {
    const meal = mealNutrition([{ grams: 30, food: null }], 1);
    expect(meal.kcal).toBeNull();
    expect(meal.kcalComplete).toBe(false);
    expect(meal.protein.grams).toBeNull();
  });

  it("never divides by zero portions", () => {
    const meal = mealNutrition([{ grams: 100, food: oats }], 0);
    expect(meal.kcal).toBe(370);
  });
});

describe("gramsForPortions", () => {
  it("scales a row by the portions eaten over the portions made", () => {
    expect(gramsForPortions(800, 1.5, 4)).toBe(300);
    expect(gramsForPortions(200, 1, 1)).toBe(200);
  });

  it("rounds to the tenth of a gram the log stores", () => {
    expect(gramsForPortions(100, 1, 3)).toBe(33.3);
  });
});
