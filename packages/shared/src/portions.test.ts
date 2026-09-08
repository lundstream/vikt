import { describe, expect, it } from "vitest";
import {
  allPortionUnits,
  FALLBACK_GRAMS,
  HOUSEHOLD_MEASURES,
  resolveDefaultAmount,
  formatPortion,
  hintGrams,
  normaliseUnit,
  portionUnits,
  resolvePortion,
} from "./portions.js";

/**
 * The rule this file holds: **a portion label is never a claim about mass.**
 *
 * Grams come from a hint when one exists and from an estimate when one does
 * not, and the difference is reported rather than smoothed over. Everything
 * else here is Swedish plural, which is why the alias table is a table.
 */

describe("reducing a unit to something a hint can be looked up under", () => {
  it("handles the plurals people and models actually write", () => {
    expect(normaliseUnit("skivor")).toBe("skiva");
    expect(normaliseUnit("Skivor")).toBe("skiva");
    expect(normaliseUnit("bitar")).toBe("bit");
    expect(normaliseUnit("klyftor")).toBe("klyfta");
    expect(normaliseUnit("portioner")).toBe("portion");
    expect(normaliseUnit("stycken")).toBe("st");
    expect(normaliseUnit("msk.")).toBe("msk");
    expect(normaliseUnit("matskedar")).toBe("msk");
  });

  it("leaves a word it does not know alone", () => {
    // Not stemmed. A guess here becomes the wrong food's mass; an unknown unit
    // simply fails to resolve, which is visible and correctable.
    expect(normaliseUnit("kruka")).toBe("kruka");
    expect(normaliseUnit("ris")).toBe("ris");
  });
});

describe("finding a hint", () => {
  const hints = { skiva: 35, portion: 250 };

  it("matches across plural forms", () => {
    expect(hintGrams("skivor", hints)).toEqual({ grams: 35, source: "hint" });
  });

  it("answers null for a unit nothing knows", () => {
    expect(hintGrams("klyfta", hints)).toBeNull();
  });

  /** The user's own scale beats whoever packaged it. */
  it("prefers the user's own hint", () => {
    expect(hintGrams("skiva", hints, { skiva: 42 })).toEqual({
      grams: 42,
      source: "user_hint",
    });
  });

  it("ignores a nonsense figure rather than multiplying by it", () => {
    expect(hintGrams("skiva", { skiva: 0 })).toBeNull();
    expect(hintGrams("skiva", { skiva: Number.NaN })).toBeNull();
  });
});

describe("resolving a stated portion to grams", () => {
  const ham = { skiva: 12 };

  /** "fem tunna skivor rökt skinka": the count is the part that is known. */
  it("multiplies a hint by the count", () => {
    const result = resolvePortion({ count: 5, unit: "skivor" }, 200, ham);
    expect(result.grams).toBe(60);
    expect(result.source).toBe("hint");
    expect(result.portion).toEqual({ count: 5, unit: "skivor" });
  });

  /**
   * A food with no hint. It still resolves to grams, and it still says the
   * grams are a guess, which is the whole requirement.
   */
  it("falls back to the estimate and marks it as one", () => {
    const result = resolvePortion({ count: 1, unit: "citron" }, 100, null);
    expect(result.grams).toBe(100);
    expect(result.source).toBe("estimate");
    // The label survives: it is what makes a wrong estimate spottable.
    expect(result.portion).toEqual({ count: 1, unit: "citron" });
  });

  it("is an estimate when nothing was stated", () => {
    expect(resolvePortion(null, 175, ham)).toEqual({
      portion: null,
      grams: 175,
      source: "estimate",
    });
  });

  it("refuses a count that is not a count", () => {
    expect(resolvePortion({ count: 0, unit: "skiva" }, 30, ham).source).toBe("estimate");
    expect(resolvePortion({ count: -2, unit: "skiva" }, 30, ham).grams).toBe(30);
  });

  it("keeps a half portion", () => {
    expect(resolvePortion({ count: 1.5, unit: "dl" }, 100, { dl: 103 }).grams).toBe(154.5);
  });
});

describe("writing a portion out", () => {
  it("uses the Swedish decimal comma and the word it was given", () => {
    expect(formatPortion({ count: 1, unit: "citron" })).toBe("1 citron");
    expect(formatPortion({ count: 2, unit: "ägg" })).toBe("2 ägg");
    expect(formatPortion({ count: 1.5, unit: "dl" })).toBe("1,5 dl");
    // Not pluralised here: the caller supplies the word that fits the count.
    expect(formatPortion({ count: 5, unit: "skivor" })).toBe("5 skivor");
  });
});

describe("listing the units a food can be measured in", () => {
  it("puts the user's own first and does not repeat a unit", () => {
    const units = portionUnits({ skiva: 35, portion: 250 }, { skivor: 42 });
    expect(units[0]).toEqual({ unit: "skivor", grams: 42, own: true });
    expect(units.map((u) => u.unit)).toEqual(["skivor", "portion"]);
  });

  it("is empty when nothing is known, rather than inventing one", () => {
    expect(portionUnits(null, null)).toEqual([]);
  });
});

/**
 * The three layers, and the fallback (D85).
 *
 * `serving_hints` alone left almost everything at 100 g, because
 * Livsmedelsverket publishes no serving data and Open Food Facts carries it
 * inconsistently. These four cases are the whole point of the layering: each
 * one is a food that would otherwise have defaulted to a placeholder.
 */
describe("resolving what to put in the grams field", () => {
  it("uses what the user last ate of it, over everything else", () => {
    const result = resolveDefaultAmount({
      lastGrams: 250,
      userHints: { portion: 200 },
      sourceHints: { portion: 150 },
      category: "dairy_liquid",
    });

    // 250 g of filmjölk last time is 250 g this time. It is not an equivalence,
    // it is what this person actually ate.
    expect(result).toEqual({ grams: 250, source: "last", unit: null });
  });

  it("uses the user's own portion when there is no last amount", () => {
    expect(
      resolveDefaultAmount({ userHints: { skiva: 42 }, sourceHints: { portion: 30 } }),
    ).toEqual({ grams: 42, source: "user_hint", unit: "skiva" });
  });

  it("resolves a household measure from the category alone", () => {
    // Nothing on the item, nothing from the user: the table is what is left.
    expect(resolveDefaultAmount({ category: "egg" })).toEqual({
      grams: 60,
      source: "household",
      unit: "st",
    });
    expect(resolveDefaultAmount({ category: "bread" }).grams).toBe(35);
  });

  /** The honest case: nothing knew, and the screen has to say so. */
  it("falls back to grams and reports that it did", () => {
    expect(resolveDefaultAmount({})).toEqual({
      grams: FALLBACK_GRAMS,
      source: "fallback",
      unit: null,
    });
    expect(resolveDefaultAmount({ category: "not-a-category" }).source).toBe("fallback");
  });

  it("ignores a last amount that is not an amount", () => {
    expect(resolveDefaultAmount({ lastGrams: 0, category: "egg" }).source).toBe("household");
    expect(resolveDefaultAmount({ lastGrams: null, category: "egg" }).source).toBe("household");
  });
});

describe("the units a food can be counted in", () => {
  it("offers all three layers, the user's own first", () => {
    const units = allPortionUnits({
      userHints: { skiva: 42 },
      sourceHints: { portion: 30 },
      category: "bread",
    });

    expect(units[0]).toEqual({ unit: "skiva", grams: 42, source: "user_hint" });
    expect(units.map((u) => u.unit)).toContain("portion");
    // The table's own "skiva" is not repeated: the user's wins on the key.
    expect(units.filter((u) => u.unit === "skiva")).toHaveLength(1);
  });

  it("offers the household table alone when nothing else knows", () => {
    const units = allPortionUnits({ category: "dairy_liquid" });
    expect(units.map((u) => u.unit)).toEqual(["dl", "msk", "tsk", "glas"]);
    expect(units.every((u) => u.source === "household")).toBe(true);
  });

  it("is empty for a food with no category and no hints", () => {
    expect(allPortionUnits({})).toEqual([]);
  });
});

/**
 * Densities differ by category, and a table that ignored that would be worse
 * than none: confidently wrong in the direction people cook in.
 */
describe("the household table", () => {
  it("knows a decilitre of flour is not a decilitre of milk", () => {
    expect(HOUSEHOLD_MEASURES.flour.dl).toBe(60);
    expect(HOUSEHOLD_MEASURES.dairy_liquid.dl).toBe(100);
    expect(HOUSEHOLD_MEASURES.oil.msk).toBe(14);
  });

  it("does not offer a count for things that have no natural one", () => {
    // "One vegetable" is not a quantity; "one egg" is.
    expect(HOUSEHOLD_MEASURES.egg.st).toBe(60);
    expect(HOUSEHOLD_MEASURES.flour.st).toBeUndefined();
  });
});
