import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasEnoughToPlot, MIN_PAIRS_TO_PLOT, pairSeries } from "./correlate.js";

const map = (entries: [string, number | null][]) => new Map(entries);

describe("pairing two daily series", () => {
  it("keeps only days where both have a value", () => {
    const result = pairSeries(
      map([
        ["2026-02-01", 7],
        ["2026-02-02", 6],
        ["2026-02-03", 8],
      ]),
      map([
        ["2026-02-01", 4],
        ["2026-02-03", 5],
      ]),
    );

    expect(result.pairs).toEqual([
      { localDate: "2026-02-01", x: 7, y: 4 },
      { localDate: "2026-02-03", x: 8, y: 5 },
    ]);
  });

  /**
   * The mistake this guards against does not throw. Filling a missing sleep
   * rating with zero puts a column of points at x=0 that reads as a pattern.
   */
  it("drops a half-logged day instead of filling it with zero", () => {
    const result = pairSeries(
      map([["2026-02-01", 7]]),
      map([["2026-02-01", null]]),
    );

    expect(result.pairs).toEqual([]);
    expect(result.unpairedDays).toBe(1);
  });

  it("counts the days it had to drop, so the sample cannot look complete", () => {
    const result = pairSeries(
      map([
        ["2026-02-01", 7],
        ["2026-02-02", 6],
        ["2026-02-03", 8],
      ]),
      map([["2026-02-01", 4]]),
    );

    expect(result.sampleSize).toBe(1);
    expect(result.unpairedDays).toBe(2);
  });

  it("reports the date range of the pairs, not of the inputs", () => {
    const result = pairSeries(
      map([
        ["2026-01-01", 1],
        ["2026-02-01", 2],
        ["2026-03-01", 3],
      ]),
      map([
        ["2026-02-01", 9],
        ["2026-03-01", 9],
      ]),
    );

    expect(result.range).toEqual({ from: "2026-02-01", to: "2026-03-01" });
  });

  it("has a null range and an empty sample when nothing pairs", () => {
    const result = pairSeries(map([["2026-02-01", 7]]), map([["2026-03-01", 4]]));

    expect(result.sampleSize).toBe(0);
    expect(result.range).toBeNull();
  });

  it("returns pairs in date order regardless of input order", () => {
    const result = pairSeries(
      map([
        ["2026-02-03", 1],
        ["2026-02-01", 2],
      ]),
      map([
        ["2026-02-01", 9],
        ["2026-02-03", 8],
      ]),
    );

    expect(result.pairs.map((pair) => pair.localDate)).toEqual([
      "2026-02-01",
      "2026-02-03",
    ]);
  });

  it("will not plot below the minimum sample", () => {
    const days = Array.from({ length: MIN_PAIRS_TO_PLOT - 1 }, (_, i): [string, number] => [
      `2026-02-${String(i + 1).padStart(2, "0")}`,
      i,
    ]);

    expect(hasEnoughToPlot(pairSeries(map(days), map(days)))).toBe(false);

    days.push(["2026-02-28", 1]);
    expect(hasEnoughToPlot(pairSeries(map(days), map(days)))).toBe(true);
  });
});

/**
 * D34, enforced rather than described.
 *
 * The decision is that this view shows data, sample size and date range and
 * computes no statistic — so a later change that adds one has to delete this
 * test to do it, which is exactly the moment the decision should be reopened
 * deliberately instead of drifting.
 */
describe("the deliberate absence of a statistic", () => {
  const source = readFileSync(fileURLToPath(new URL("./correlate.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("exports nothing that computes a correlation or a fit", () => {
    for (const banned of [
      "pearson",
      "spearman",
      "correlationCoefficient",
      "rSquared",
      "leastSquares",
      "regress",
      "slope",
      "pValue",
      "significan",
    ]) {
      expect(code.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("does not import the regression that the projections use", () => {
    expect(code).not.toContain("project.js");
  });

  it("returns only the points, the count and the range", () => {
    const result = pairSeries(map([["2026-02-01", 1]]), map([["2026-02-01", 2]]));
    expect(Object.keys(result).sort()).toEqual(["pairs", "range", "sampleSize", "unpairedDays"]);
  });
});
