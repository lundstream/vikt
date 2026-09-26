import { describe, expect, it } from "vitest";
import { checkLabel, computedKcal, type LabelFigures } from "./label.js";

/**
 * The first guard (D190), against the three labels the probe read. Figures
 * are what is printed, read by a person from the photographs in
 * `scratch/vision/labels`.
 */

const none = { polyols: null, fibre: null, alcohol: null };

/** A Swedish quark cup, one column per 100 g. */
const quark: LabelFigures = {
  energyKj: 248,
  energyKcal: 59,
  fat: 0.2,
  carbohydrate: 4.4,
  protein: 8.8,
  ...none,
};

/** Sugar-free sweets: polyols 8,3 g inside 11 g of carbohydrate, fibre 56 g. */
const sweets: LabelFigures = {
  energyKj: null,
  energyKcal: 164,
  fat: 0,
  carbohydrate: 11,
  polyols: 8.3,
  fibre: 56,
  protein: 4.1,
  alcohol: null,
};

/** A crumpled foil bag, per 100 g beside per 25 g and RI. */
const foil: LabelFigures = {
  energyKj: 1636,
  energyKcal: 388,
  fat: 9.4,
  carbohydrate: 51.2,
  fibre: 3.6,
  protein: 22,
  polyols: null,
  alcohol: null,
};

describe("checkLabel", () => {
  it("passes all three labels as printed", () => {
    for (const label of [quark, sweets, foil]) {
      const check = checkLabel(label);
      expect(check.ok, JSON.stringify(check)).toBe(true);
    }
    expect(checkLabel(quark)).toMatchObject({ ok: true, statedKcal: 59 });
    expect((checkLabel(quark) as { deviation: number }).deviation).toBeCloseTo(0.075, 2);
  });

  /**
   * The case the check exists for, both ways: 56 g of fibre is what the bag
   * says, and 5,6 g is the same digits with the comma misplaced. Only one of
   * them adds up to 164 kcal.
   */
  it("tells 56 g of fibre from a misread 5,6 g", () => {
    expect(checkLabel({ ...sweets, fibre: 56 }).ok).toBe(true);
    const misread = checkLabel({ ...sweets, fibre: 5.6 });
    expect(misread).toMatchObject({ ok: false, reason: "sum_disagrees" });
    expect(misread.deviation!).toBeGreaterThan(0.5);
  });

  /** And the other way: a label that really says 5,6 g, misread as 56. */
  it("fails 56 g read where 5,6 g is printed", () => {
    const printed: LabelFigures = { ...foil, fibre: 5.6, carbohydrate: 49.4 };
    expect(checkLabel(printed).ok).toBe(true);
    expect(checkLabel({ ...printed, fibre: 56 })).toMatchObject({ ok: false, reason: "sum_disagrees" });
  });

  /**
   * Polyols are inside carbohydrate on an EU label. Counting them on top would
   * fail the sweets, which were read correctly.
   */
  it("prices polyols inside the carbohydrate, not on top of it", () => {
    expect(computedKcal(sweets)).toBeCloseTo(159.1, 1);
    const onTop = 11 * 4 + 8.3 * 2.4 + 56 * 2 + 4.1 * 4;
    expect(Math.abs(onTop - 164) / 164).toBeGreaterThan(0.15);
  });

  it("fails what the probe's model actually read off the other two", () => {
    // The blurred bag, verbatim from qwen3-vl:8b (D190).
    expect(
      checkLabel({
        energyKj: 1885,
        energyKcal: 450,
        fat: 69,
        carbohydrate: 119,
        polyols: 8.3,
        fibre: 56,
        protein: 4.1,
        alcohol: null,
      }).ok,
    ).toBe(false);
    // The foil bag: 9,4 g of fat read as 94.
    expect(
      checkLabel({
        energyKj: 1650,
        energyKcal: 388,
        fat: 94,
        carbohydrate: 0,
        polyols: 0,
        fibre: 0,
        protein: 55,
        alcohol: null,
      }).ok,
    ).toBe(false);
  });

  it("fails a kJ figure that disagrees with the kcal beside it", () => {
    // The first probe read 248 kJ as 2 480 beside the right 59 kcal.
    expect(checkLabel({ ...quark, energyKj: 2480 })).toMatchObject({
      ok: false,
      reason: "energy_pair_disagrees",
    });
  });

  it("reads kJ alone when no kcal is printed", () => {
    expect(checkLabel({ ...quark, energyKcal: null })).toMatchObject({ ok: true });
  });

  it("needs the energy, and the three mandatory macros", () => {
    expect(checkLabel({ ...quark, energyKcal: null, energyKj: null })).toMatchObject({
      ok: false,
      reason: "no_energy",
    });
    expect(checkLabel({ ...quark, protein: null })).toMatchObject({
      ok: false,
      reason: "missing_macros",
    });
  });

  it("refuses more polyols than carbohydrate, which no label prints", () => {
    expect(checkLabel({ ...sweets, polyols: 83 })).toMatchObject({
      ok: false,
      reason: "polyols_exceed_carbohydrate",
    });
  });

  it("counts alcohol at 7 kcal per gram", () => {
    // A cider: 1,9 g of carbohydrate... and 4,5 g of alcohol.
    const cider: LabelFigures = {
      energyKj: null,
      energyKcal: 40,
      fat: 0,
      carbohydrate: 1.9,
      protein: 0,
      polyols: null,
      fibre: null,
      alcohol: 4.5,
    };
    expect(checkLabel(cider).ok).toBe(true);
    expect(checkLabel({ ...cider, alcohol: null }).ok).toBe(false);
  });
});
