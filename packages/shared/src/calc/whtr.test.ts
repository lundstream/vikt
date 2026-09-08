import { describe, expect, it } from "vitest";
import { computeSeriesTrend, computeTrend } from "./trend.js";
import { computeWhtrSeries, latestWhtr, whtr, WHTR_RULE_OF_THUMB } from "./whtr.js";

describe("whtr", () => {
  it("is waist over height", () => {
    expect(whtr(88, 180)).toBeCloseTo(0.4889, 4);
  });

  it("is absent rather than wrong when an input is missing", () => {
    expect(whtr(null, 180)).toBeNull();
    expect(whtr(88, null)).toBeNull();
    expect(whtr(88, 0)).toBeNull();
    expect(whtr(Number.NaN, 180)).toBeNull();
  });

  it("keeps the rule of thumb as a constant, not a hard-coded 0.5", () => {
    expect(WHTR_RULE_OF_THUMB).toBe(0.5);
  });
});

describe("the waist series", () => {
  const readings = [
    { localDate: "2026-01-01", waistCm: 96 },
    { localDate: "2026-01-08", waistCm: 95 },
    { localDate: "2026-01-15", waistCm: 94.5 },
    { localDate: "2026-01-22", waistCm: 93 },
  ];

  /**
   * D32. The point of routing measurements through §4.1 is that there is one
   * smoother, so this asserts the *same function* produced the numbers rather
   * than that two implementations happen to agree today.
   */
  it("is the §4.1 smoother applied to waist, not a second implementation", () => {
    const series = computeWhtrSeries(readings, 180);
    const smoothed = computeSeriesTrend(
      readings.map((r) => ({ localDate: r.localDate, value: r.waistCm })),
    );

    expect(series).toHaveLength(smoothed.length);
    for (const [i, point] of series.entries()) {
      expect(point.whtr).toBeCloseTo(smoothed[i]!.trend / 180, 12);
    }
  });

  it("shares an axis with the weight trend, day for day", () => {
    const weight = computeTrend(
      readings.map((r) => ({ localDate: r.localDate, weightKg: 90 })),
    );
    const waist = computeWhtrSeries(readings, 180);

    expect(waist.map((p) => p.localDate)).toEqual(weight.map((p) => p.localDate));
  });

  it("leaves unmeasured days raw-null rather than inventing a reading", () => {
    const series = computeWhtrSeries(readings, 180);
    const gapDay = series.find((point) => point.localDate === "2026-01-05")!;

    expect(gapDay.raw).toBeNull();
    expect(gapDay.interpolated).toBe(true);
    expect(gapDay.whtr).toBeGreaterThan(0);
  });

  it("smooths, so a single mis-measured day does not move the line by its full error", () => {
    const withBlip = [...readings, { localDate: "2026-01-23", waistCm: 96.5 }];
    const series = computeWhtrSeries(withBlip, 180);
    const last = series.at(-1)!;

    // The raw point sits 2.5 cm above the line; the line must not follow it there.
    const rawJump = last.raw! - series.at(-2)!.whtr;
    const lineMove = last.whtr - series.at(-2)!.whtr;

    expect(rawJump).toBeGreaterThan(0.013);
    expect(lineMove).toBeLessThan(rawJump / 5);
  });

  it("has nothing to show without a height", () => {
    expect(computeWhtrSeries(readings, null)).toEqual([]);
    expect(computeWhtrSeries(readings, 0)).toEqual([]);
  });

  it("has nothing to show without a waist history", () => {
    expect(computeWhtrSeries([], 180)).toEqual([]);
    expect(latestWhtr([])).toBeNull();
  });

  it("reports the latest smoothed ratio", () => {
    const series = computeWhtrSeries(readings, 180);
    expect(latestWhtr(series)).toBeCloseTo(series.at(-1)!.whtr, 12);
    expect(latestWhtr(series)).toBeLessThan(96 / 180);
  });
});
