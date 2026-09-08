import { describe, expect, it } from "vitest";
import {
  EMPTY_MACROS,
  KJ_PER_KCAL,
  energyPairAgrees,
  kcalToKj,
  kjToKcal,
  normaliseFailure,
  optionalAmount,
  scaleToGrams,
  toKcal,
} from "./food.js";

/**
 * The two data hazards in Phase 3, both of which feed the intake series that
 * adaptive TDEE is computed from.
 */

describe("energy units", () => {
  it("uses the thermochemical calorie, as food labels do", () => {
    expect(KJ_PER_KCAL).toBe(4.184);
  });

  it("converts kJ to kcal", () => {
    expect(kjToKcal(2000)).toBeCloseTo(478.01, 2);
    expect(kjToKcal(418.4)).toBeCloseTo(100, 10);
  });

  it("round-trips", () => {
    for (const kcal of [0, 1, 250, 2000]) {
      expect(kjToKcal(kcalToKj(kcal))).toBeCloseTo(kcal, 10);
    }
  });

  /**
   * The failure this exists to prevent: a 2000 kJ ready meal read as 2000 kcal
   * is a factor of 4.184 straight into the intake series.
   */
  it("does not read kJ as kcal", () => {
    expect(toKcal(2000, "kJ")).toBeCloseTo(478.01, 2);
    expect(toKcal(2000, "kcal")).toBe(2000);
    expect(toKcal(2000, "kJ")).not.toBeCloseTo(2000, 0);
  });

  it("refuses a value whose unit is unknown, rather than assuming kcal", () => {
    expect(toKcal(2000, null)).toBeNull();
    expect(toKcal(2000, undefined)).toBeNull();
  });

  it("refuses a value that is not a usable number", () => {
    expect(toKcal(Number.NaN, "kcal")).toBeNull();
    expect(toKcal(-10, "kcal")).toBeNull();
    expect(toKcal(Number.POSITIVE_INFINITY, "kJ")).toBeNull();
  });

  it("accepts zero, which is a real energy value", () => {
    expect(toKcal(0, "kcal")).toBe(0);
  });
});

describe("cross-checking a kcal/kJ pair", () => {
  it("agrees when the two are consistent", () => {
    expect(energyPairAgrees(478, 2000)).toBe(true);
    expect(energyPairAgrees(100, 418.4)).toBe(true);
  });

  it("disagrees when they are not", () => {
    // A record where somebody put kJ in the kcal field.
    expect(energyPairAgrees(2000, 2000)).toBe(false);
    expect(energyPairAgrees(100, 1000)).toBe(false);
  });

  it("returns null when there is nothing to compare", () => {
    expect(energyPairAgrees(null, 2000)).toBeNull();
    expect(energyPairAgrees(478, null)).toBeNull();
    expect(energyPairAgrees(0, 0)).toBeNull();
  });

  it("tolerates the rounding real labels carry", () => {
    // 478 kcal rounded from 2000 kJ, and the label says 2001.
    expect(energyPairAgrees(478, 2001)).toBe(true);
  });
});

describe("missing values are absent, never zero", () => {
  it("reads a missing macro as null", () => {
    expect(optionalAmount(undefined)).toBeNull();
    expect(optionalAmount(null)).toBeNull();
    expect(optionalAmount("")).toBeNull();
  });

  it("reads text as null rather than NaN", () => {
    expect(optionalAmount("unknown")).toBeNull();
    expect(optionalAmount("n/a")).toBeNull();
  });

  it("refuses a negative amount", () => {
    expect(optionalAmount(-5)).toBeNull();
    expect(optionalAmount("-5")).toBeNull();
  });

  it("keeps a real zero, which is different from missing", () => {
    expect(optionalAmount(0)).toBe(0);
    expect(optionalAmount("0")).toBe(0);
  });

  it("accepts a comma decimal, which appears in European data", () => {
    expect(optionalAmount("4,5")).toBe(4.5);
  });
});

describe("scaling to a portion", () => {
  const food = {
    kcalPer100: 250,
    macros: { proteinG: 10, carbsG: 30, fatG: null, fiberG: 2, saltG: null },
  };

  it("scales energy and macros together", () => {
    const scaled = scaleToGrams(food, 200);
    expect(scaled.kcal).toBe(500);
    expect(scaled.macros.proteinG).toBe(20);
    expect(scaled.macros.carbsG).toBe(60);
  });

  it("keeps an absent macro absent — a scaled unknown is still unknown", () => {
    const scaled = scaleToGrams(food, 200);
    expect(scaled.macros.fatG).toBeNull();
    expect(scaled.macros.saltG).toBeNull();
  });

  it("handles a part portion", () => {
    const scaled = scaleToGrams(food, 35);
    expect(scaled.kcal).toBeCloseTo(87.5, 10);
    expect(scaled.macros.proteinG).toBeCloseTo(3.5, 10);
  });

  it("scales an entirely unknown food to entirely unknown macros", () => {
    const scaled = scaleToGrams({ kcalPer100: 100, macros: EMPTY_MACROS }, 250);
    expect(scaled.kcal).toBe(250);
    expect(Object.values(scaled.macros).every((value) => value === null)).toBe(true);
  });
});

describe("normalisation failures", () => {
  it("carries a machine code and a Swedish message", () => {
    const result = normaliseFailure("unknown_energy_unit");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("unknown_energy_unit");
    expect(result.failure.message).toMatch(/kcal eller kJ/);
  });

  it("tells the user what to do next rather than only what went wrong", () => {
    for (const reason of ["no_energy", "unknown_energy_unit", "inconsistent_energy"] as const) {
      const result = normaliseFailure(reason);
      if (result.ok) throw new Error("expected a failure");
      expect(result.failure.message, reason).toMatch(/Skriv in kalorierna själv/);
    }
  });
});
