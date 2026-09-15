import { describe, expect, it } from "vitest";
import { KJ_PER_KCAL } from "../food.js";
import {
  dayMacros,
  ENERGY_PERCENT,
  FIBER_G_PER_MJ,
  KJ_PER_G,
  LOW_ENERGY_MJ,
  MACRO_COVERAGE_THRESHOLD,
  macroTargets,
  proteinTarget,
  PROTEIN_G_PER_KG,
  weeklyMean,
  windowMacroTotal,
  type MacroEntry,
} from "./macros.js";

const entry = (kcal: number, macros: Partial<Omit<MacroEntry, "kcal">> = {}): MacroEntry => ({
  kcal,
  proteinG: null,
  carbsG: null,
  fatG: null,
  fiberG: null,
  ...macros,
});

describe("the NNR 2023 constants", () => {
  /**
   * These are the source's numbers, not ours, so they are asserted literally.
   * A change here is a change of source and belongs in DECISIONS.md.
   */
  it("uses NNR's energy factors rather than the 4/4/9 shorthand", () => {
    expect(KJ_PER_G.protein).toBe(17);
    expect(KJ_PER_G.carbs).toBe(17);
    expect(KJ_PER_G.fat).toBe(37);
    expect(KJ_PER_G.fiber).toBe(8);
  });

  it("would disagree with the shorthand, which is the point of not using it", () => {
    // 4 kcal/g is 16.7 kJ/g and 9 kcal/g is 37.7. Close enough to look right,
    // far enough to move a protein target by grams.
    expect(KJ_PER_G.protein / KJ_PER_KCAL).not.toBeCloseTo(4, 1);
    expect(KJ_PER_G.fat / KJ_PER_KCAL).toBeCloseTo(8.84, 2);
  });

  it("sits inside NNR's recommended bands", () => {
    expect(ENERGY_PERCENT.fat).toBeGreaterThanOrEqual(0.32);
    expect(ENERGY_PERCENT.fat).toBeLessThanOrEqual(0.33);
    expect(ENERGY_PERCENT.carbs).toBeGreaterThanOrEqual(0.52);
    expect(ENERGY_PERCENT.carbs).toBeLessThanOrEqual(0.53);
    expect(ENERGY_PERCENT.protein).toBe(0.15);
  });

  it("accounts for essentially all of the energy, since fibre is inside carbohydrate", () => {
    const total = ENERGY_PERCENT.fat + ENERGY_PERCENT.carbs + ENERGY_PERCENT.protein;
    expect(total).toBeCloseTo(1, 2);
  });
});

describe("macroTargets", () => {
  it("derives grams from the energy target using the kJ factors", () => {
    const targets = macroTargets({ targetKcal: 2400, trendWeightKg: 80 });
    const kj = 2400 * KJ_PER_KCAL;

    expect(targets).not.toBeNull();
    expect(targets?.fatG).toBe(Math.round((kj * 0.325) / 37));
    expect(targets?.carbsG).toBe(Math.round((kj * 0.525) / 17));
  });

  it("scales fibre with intake at 3 g per MJ, not a flat figure", () => {
    const small = macroTargets({ targetKcal: 1500, trendWeightKg: 70 });
    const large = macroTargets({ targetKcal: 3000, trendWeightKg: 70 });

    expect(small?.fiberG).toBe(Math.round(((1500 * KJ_PER_KCAL) / 1000) * FIBER_G_PER_MJ));
    expect(large?.fiberG).toBe(small!.fiberG * 2);
  });

  it("is absent rather than wrong without a usable target", () => {
    expect(macroTargets({ targetKcal: 0, trendWeightKg: 80 })).toBeNull();
    expect(macroTargets({ targetKcal: -100, trendWeightKg: 80 })).toBeNull();
    expect(macroTargets({ targetKcal: Number.NaN, trendWeightKg: 80 })).toBeNull();
  });
});

/**
 * The constraint the source actually forces, and the one most likely to be
 * "simplified" back out by someone who reads 15 E% and stops there.
 */
describe("protein in a deficit", () => {
  it("takes the g/kg figure below 8 MJ, where the percentage under-delivers", () => {
    // 1600 kcal is 6.69 MJ, under NNR's 8 MJ threshold.
    const targets = macroTargets({ targetKcal: 1600, trendWeightKg: 92 });

    const fromEnergy = (1600 * KJ_PER_KCAL * ENERGY_PERCENT.protein) / KJ_PER_G.protein;
    const fromWeight = 92 * PROTEIN_G_PER_KG;

    expect(fromWeight).toBeGreaterThan(fromEnergy);
    expect(targets?.proteinBasis).toBe("per_kg");
    expect(targets?.proteinG).toBe(Math.round(fromWeight));
    expect(targets?.belowLowEnergyThreshold).toBe(true);
  });

  it("takes the E% figure above 8 MJ, where it is the higher of the two", () => {
    // 2600 kcal is 10.88 MJ.
    const targets = macroTargets({ targetKcal: 2600, trendWeightKg: 92 });

    const fromEnergy = (2600 * KJ_PER_KCAL * ENERGY_PERCENT.protein) / KJ_PER_G.protein;

    expect(fromEnergy).toBeGreaterThan(92 * PROTEIN_G_PER_KG);
    expect(targets?.proteinBasis).toBe("energy_percent");
    expect(targets?.proteinG).toBe(Math.round(fromEnergy));
    expect(targets?.belowLowEnergyThreshold).toBe(false);
  });

  it("never falls below the g/kg floor as the target shrinks", () => {
    const floor = 92 * PROTEIN_G_PER_KG;
    for (const targetKcal of [1200, 1400, 1600, 1800, 2000, 2200]) {
      expect(macroTargets({ targetKcal, trendWeightKg: 92 })!.proteinG).toBeGreaterThanOrEqual(
        Math.round(floor),
      );
    }
  });

  it("flags the threshold at 8 MJ exactly where NNR puts it", () => {
    const boundaryKcal = (LOW_ENERGY_MJ * 1000) / KJ_PER_KCAL;
    expect(macroTargets({ targetKcal: boundaryKcal - 1, trendWeightKg: 80 })!
      .belowLowEnergyThreshold).toBe(true);
    expect(macroTargets({ targetKcal: boundaryKcal + 1, trendWeightKg: 80 })!
      .belowLowEnergyThreshold).toBe(false);
  });

  it("falls back to the percentage when there is no trend weight yet", () => {
    const result = proteinTarget(1600, null);
    expect(result.basis).toBe("energy_percent");
    // Not zero, and not a guessed body weight.
    expect(result.grams).toBeGreaterThan(0);
  });
});

/**
 * Absent is not zero (D44), in the form where it is hardest to see: the total
 * still looks like an answer.
 */
describe("macro coverage", () => {
  it("reports coverage weighted by energy, not by entry count", () => {
    const day = dayMacros([
      entry(100, { proteinG: 5 }),
      entry(100, { proteinG: 5 }),
      entry(100, { proteinG: 5 }),
      entry(100, { proteinG: 5 }),
      entry(100, { proteinG: 5 }),
      entry(900), // the unlabelled dinner
    ]);

    // Five of six entries carry protein, which by count would read 83%.
    expect(day.protein.coverage).toBeCloseTo(500 / 1400, 4);
    expect(day.protein.complete).toBe(false);
  });

  it("marks a total incomplete below the threshold and complete at it", () => {
    const short = dayMacros([entry(850, { fatG: 30 }), entry(150)]);
    expect(short.fat.coverage).toBeCloseTo(0.85, 4);
    expect(short.fat.complete).toBe(false);

    const exact = dayMacros([entry(900, { fatG: 30 }), entry(100)]);
    expect(exact.fat.coverage).toBeCloseTo(MACRO_COVERAGE_THRESHOLD, 4);
    expect(exact.fat.complete).toBe(true);
  });

  it("keeps coverage per macro, since a food can carry protein and not fibre", () => {
    const day = dayMacros([
      entry(500, { proteinG: 40, fiberG: 3 }),
      entry(500, { proteinG: 20 }),
    ]);

    expect(day.protein.coverage).toBe(1);
    expect(day.fiber.coverage).toBeCloseTo(0.5, 4);
    expect(day.protein.complete).toBe(true);
    expect(day.fiber.complete).toBe(false);
  });

  it("gives null, not 0, for a macro no entry carries", () => {
    const day = dayMacros([entry(500), entry(300)]);
    expect(day.protein.grams).toBeNull();
    expect(day.carbs.grams).toBeNull();
    expect(day.kcal).toBe(800);
  });

  it("says nothing was logged rather than showing a zero day", () => {
    const day = dayMacros([]);
    expect(day.kcal).toBeNull();
    expect(day.protein.grams).toBeNull();
    expect(day.protein.coverage).toBe(0);
  });

  it("sums only the entries that carry the macro", () => {
    const day = dayMacros([entry(400, { carbsG: 50 }), entry(100, { carbsG: 10 }), entry(20)]);
    expect(day.carbs.grams).toBe(60);
  });
});

/**
 * A window's figure is the mean of its days' known grams, and says "minst" as
 * soon as one of them was under the gate (D55, addendum 2026-09-15).
 */
describe("a macro over a window of days", () => {
  const complete = dayMacros([entry(1000, { proteinG: 60 }), entry(1000, { proteinG: 40 })]);

  it("is a plain mean when every logged day cleared the gate", () => {
    const total = windowMacroTotal([complete, complete, dayMacros([])], "protein");

    expect(total.meanG).toBe(100);
    expect(total.days).toBe(2);
    expect(total.partialDays).toBe(0);
    expect(total.coverage).toBe(1);
    expect(total.complete).toBe(true);
  });

  it("includes a partial day's known grams and marks the mean as a floor", () => {
    // 20 g known from half of a 1800 kcal day.
    const partial = dayMacros([entry(900, { proteinG: 20 }), entry(900)]);
    const total = windowMacroTotal([complete, complete, complete, partial], "protein");

    expect(total.meanG).toBe((100 * 3 + 20) / 4);
    expect(total.days).toBe(4);
    expect(total.partialDays).toBe(1);
    expect(total.coverage).toBeCloseTo((6000 + 900) / (6000 + 1800), 6);
    expect(total.complete).toBe(false);
  });

  it("counts a logged day that carries none of the macro as zero known grams, and partial", () => {
    const none = dayMacros([entry(800)]);
    const total = windowMacroTotal([complete, none], "protein");

    expect(total.meanG).toBe(50);
    expect(total.partialDays).toBe(1);
    expect(total.complete).toBe(false);
  });

  it("is absent only when no logged food in the window carries the macro", () => {
    const total = windowMacroTotal([complete, complete], "fiber");

    expect(total.meanG).toBeNull();
    expect(total.days).toBe(2);
    expect(total.coverage).toBe(0);
    expect(total.complete).toBe(false);
  });

  it("is absent, with no days, when nothing was logged", () => {
    const total = windowMacroTotal([dayMacros([]), dayMacros([])], "protein");

    expect(total).toEqual({ meanG: null, days: 0, partialDays: 0, coverage: 0, complete: false });
  });
});

/**
 * NNR's values refer to average intake over at least a week, so this is what
 * the targets are compared against.
 */
describe("the weekly average", () => {
  it("averages over logged days only, treating an unlogged day as absent", () => {
    const { mean, days } = weeklyMean([100, null, 200, null, 300, null, null]);
    expect(mean).toBe(200);
    expect(days).toBe(3);
  });

  it("distinguishes a zero day from an absent one", () => {
    expect(weeklyMean([100, 0]).mean).toBe(50);
    expect(weeklyMean([100, null]).mean).toBe(100);
  });

  it("is absent when nothing was logged at all", () => {
    expect(weeklyMean([null, null, null])).toEqual({ mean: null, days: 0 });
    expect(weeklyMean([])).toEqual({ mean: null, days: 0 });
  });
});
