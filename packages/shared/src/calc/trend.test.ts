import { describe, expect, it } from "vitest";
import {
  addDays,
  computeTrend,
  eachDay,
  effectiveAlpha,
  latestTrend,
  TREND_ALPHA,
} from "./trend.js";

/**
 * Fixtures for CLAUDE.md §4.1. The EMA is the primary number in the product, so
 * the arithmetic is checked against hand-computed values rather than against
 * whatever the implementation happens to produce.
 */

const day = (n: number) => addDays("2026-01-01", n);

describe("computeTrend — a clean seeded series", () => {
  const readings = [
    { localDate: day(0), weightKg: 100 },
    { localDate: day(1), weightKg: 99 },
    { localDate: day(2), weightKg: 101 },
    { localDate: day(3), weightKg: 100 },
  ];

  it("seeds the trend on the first reading", () => {
    const points = computeTrend(readings);
    expect(points[0]).toEqual({
      localDate: day(0),
      raw: 100,
      trend: 100,
      interpolated: false,
    });
  });

  it("smooths with alpha 0.10, hand-checked", () => {
    const points = computeTrend(readings);
    // t1: 100 + 0.1 * (99  - 100)  = 99.9
    // t2: 99.9 + 0.1 * (101 - 99.9) = 100.01
    // t3: 100.01 + 0.1 * (100 - 100.01) = 100.009
    expect(points[1]!.trend).toBeCloseTo(99.9, 10);
    expect(points[2]!.trend).toBeCloseTo(100.01, 10);
    expect(points[3]!.trend).toBeCloseTo(100.009, 10);
  });

  it("uses the documented alpha", () => {
    expect(TREND_ALPHA).toBe(0.1);
  });

  it("moves less than the raw readings do", () => {
    const points = computeTrend(readings);
    const rawSpread = 101 - 99;
    const trendSpread =
      Math.max(...points.map((p) => p.trend)) - Math.min(...points.map((p) => p.trend));
    expect(trendSpread).toBeLessThan(rawSpread);
  });

  it("marks nothing as interpolated when every day has a reading", () => {
    expect(computeTrend(readings).every((p) => !p.interpolated)).toBe(true);
  });

  it("tracks a steady loss downwards, lagging behind it", () => {
    const losing = Array.from({ length: 30 }, (_, i) => ({
      localDate: day(i),
      weightKg: 100 - i * 0.1,
    }));
    const points = computeTrend(losing);
    expect(latestTrend(points)!).toBeLessThan(100);
    // The EMA lags, so it must sit above a monotonically falling raw series.
    expect(latestTrend(points)!).toBeGreaterThan(losing.at(-1)!.weightKg);
  });
});

describe("computeTrend — a series with multi-day gaps", () => {
  const readings = [
    { localDate: day(0), weightKg: 100 },
    { localDate: day(1), weightKg: 98 },
    // days 2, 3, 4 missing
    { localDate: day(5), weightKg: 96 },
  ];

  it("emits one point per day, including the missing ones", () => {
    const points = computeTrend(readings);
    expect(points).toHaveLength(6);
    expect(points.map((p) => p.localDate)).toEqual([0, 1, 2, 3, 4, 5].map(day));
  });

  it("leaves the raw series alone — a missing day is null, never filled in", () => {
    const points = computeTrend(readings);
    expect(points.map((p) => p.raw)).toEqual([100, 98, null, null, null, 96]);
  });

  it("carries the trend forward unchanged across the gap", () => {
    const points = computeTrend(readings);
    // t1: 100 + 0.1 * (98 - 100) = 99.8, then held for three days.
    expect(points[1]!.trend).toBeCloseTo(99.8, 10);
    expect(points[2]!.trend).toBeCloseTo(99.8, 10);
    expect(points[3]!.trend).toBeCloseTo(99.8, 10);
    expect(points[4]!.trend).toBeCloseTo(99.8, 10);
  });

  it("marks exactly the missing days as interpolated", () => {
    const points = computeTrend(readings);
    expect(points.map((p) => p.interpolated)).toEqual([
      false,
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it("resumes smoothing from the carried value, weighted by the gap", () => {
    const points = computeTrend(readings);
    // Four days since the last reading, so effectiveAlpha = 1 - 0.9^4 = 0.3439:
    // 99.8 + 0.3439 * (96 - 99.8) = 98.49318.
    //
    // This fixture read 99.42 before §4.1 was corrected, which was the flat
    // per-reading alpha treating a four-day gap as one step. The trend is
    // supposed to move further after a longer gap, because more time passed.
    expect(points[5]!.trend).toBeCloseTo(98.49318, 5);
  });

  it("carries forward to `to` when the last days have no reading", () => {
    const points = computeTrend(readings, { to: day(8) });
    expect(points).toHaveLength(9);
    expect(points.at(-1)).toMatchObject({
      localDate: day(8),
      raw: null,
      interpolated: true,
    });
    expect(points.at(-1)!.trend).toBeCloseTo(points[5]!.trend, 10);
  });
});

describe("computeTrend — a single reading", () => {
  const readings = [{ localDate: day(0), weightKg: 82.4 }];

  it("returns one point whose trend is the reading itself", () => {
    expect(computeTrend(readings)).toEqual([
      { localDate: day(0), raw: 82.4, trend: 82.4, interpolated: false },
    ]);
  });

  it("holds that value forward when asked to extend", () => {
    const points = computeTrend(readings, { to: day(3) });
    expect(points).toHaveLength(4);
    expect(points.every((p) => p.trend === 82.4)).toBe(true);
    expect(points.slice(1).every((p) => p.raw === null && p.interpolated)).toBe(true);
  });
});

describe("computeTrend — an empty series", () => {
  it("returns nothing rather than a flat line at zero", () => {
    expect(computeTrend([])).toEqual([]);
    expect(latestTrend([])).toBeNull();
  });

  it("returns nothing even when a range is given", () => {
    expect(computeTrend([], { from: day(0), to: day(30) })).toEqual([]);
  });

  it("ignores readings that are not finite numbers", () => {
    expect(computeTrend([{ localDate: day(0), weightKg: Number.NaN }])).toEqual([]);
  });
});

describe("computeTrend — ordering and duplicates", () => {
  it("does not care what order the readings arrive in", () => {
    const forwards = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(1), weightKg: 98 },
    ]);
    const backwards = computeTrend([
      { localDate: day(1), weightKg: 98 },
      { localDate: day(0), weightKg: 100 },
    ]);
    expect(backwards).toEqual(forwards);
  });

  it("takes the last reading for a day when handed two", () => {
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(0), weightKg: 99 },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]!.raw).toBe(99);
  });
});

describe("date helpers", () => {
  it("steps whole days inclusively", () => {
    expect([...eachDay("2026-01-01", "2026-01-04")]).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
  });

  it("crosses a month and a leap day without drifting", () => {
    expect([...eachDay("2028-02-27", "2028-03-01")]).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("crosses the European DST switch without duplicating or skipping a day", () => {
    // Stockholm springs forward on 2026-03-29. Local-date arithmetic must not
    // notice, which is why it is done in UTC.
    expect([...eachDay("2026-03-28", "2026-03-30")]).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);
  });

  it("yields a single day when both ends match", () => {
    expect([...eachDay("2026-01-01", "2026-01-01")]).toEqual(["2026-01-01"]);
  });

  it("yields nothing when the range runs backwards", () => {
    expect([...eachDay("2026-01-05", "2026-01-01")]).toEqual([]);
  });

  it("adds and subtracts days", () => {
    expect(addDays("2026-01-01", 31)).toBe("2026-02-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });
});

/**
 * Time-aware alpha — CLAUDE.md §4.1, added after the flat-alpha version was
 * found to make the smoothing constant depend on weighing frequency.
 */
describe("alpha is per day, not per reading", () => {
  it("reduces to the plain form at a one-day gap", () => {
    expect(effectiveAlpha(1)).toBeCloseTo(TREND_ALPHA, 12);
  });

  it("compounds across a gap", () => {
    // 1 - 0.9^7
    expect(effectiveAlpha(7)).toBeCloseTo(0.5217031, 6);
    expect(effectiveAlpha(3)).toBeCloseTo(0.271, 6);
  });

  it("approaches 1 for a very long gap — the reading replaces the trend", () => {
    expect(effectiveAlpha(90)).toBeGreaterThan(0.99);
    expect(effectiveAlpha(90)).toBeLessThan(1);
  });

  /**
   * The regression. A weekly weigh-in losing 1 kg a week over 16 days: the trend
   * has to land near the real 98, not stall at 99.7 the way a flat per-reading
   * alpha did.
   */
  it("tracks a weekly cadence instead of stalling", () => {
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(7), weightKg: 99 },
      { localDate: day(14), weightKg: 98 },
    ]);

    // 100 -> 100 + 0.5217*(99-100) = 99.478
    //     -> 99.478 + 0.5217*(98-99.478) = 98.707
    expect(points.at(-1)!.trend).toBeCloseTo(98.707, 3);
    // Well clear of what the per-reading version produced.
    expect(points.at(-1)!.trend).toBeLessThan(99.0);
  });

  it("renders a real 2 kg loss as most of 2 kg, not a seventh of it", () => {
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(8), weightKg: 99 },
      { localDate: day(16), weightKg: 98 },
    ]);
    // Eight-day gaps: effectiveAlpha = 1 - 0.9^8 = 0.56953.
    // 100 -> 99.43047 -> 98.61573, so the trend shows 1.384 of the real 2 kg.
    const movement = 100 - points.at(-1)!.trend;
    expect(movement).toBeCloseTo(1.384, 3);
    // The per-reading version showed 0.29 kg of the same 2 kg.
    expect(movement).toBeGreaterThan(1.3);
  });

  it("handles gaps of 1, 3 and 11 days in one series", () => {
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(1), weightKg: 99 }, // gap 1
      { localDate: day(4), weightKg: 98 }, // gap 3
      { localDate: day(15), weightKg: 97 }, // gap 11
    ]);

    const at = (n: number) => points.find((p) => p.localDate === day(n))!.trend;

    // 100 + 0.1*(99-100) = 99.9
    expect(at(1)).toBeCloseTo(99.9, 10);
    // 99.9 + (1-0.9^3)*(98-99.9) = 99.9 - 0.271*1.9 = 99.3851
    expect(at(4)).toBeCloseTo(99.3851, 4);
    // 99.3851 + (1-0.9^11)*(97-99.3851) = 99.3851 - 0.68619*2.3851 = 97.7484
    expect(at(15)).toBeCloseTo(97.7484, 3);
  });

  it("lets a reading 90 days later essentially replace the trend", () => {
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(90), weightKg: 100 },
    ]);
    // 1 - 0.9^90 = 0.99992, so the trend lands within a gram of the reading.
    expect(points.at(-1)!.trend).toBeCloseTo(100, 2);
  });

  it("leaves a daily series bit-for-bit unchanged", () => {
    // The same hand-computed values as the original fixture above.
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(1), weightKg: 99 },
      { localDate: day(2), weightKg: 101 },
      { localDate: day(3), weightKg: 100 },
    ]);
    expect(points[1]!.trend).toBeCloseTo(99.9, 10);
    expect(points[2]!.trend).toBeCloseTo(100.01, 10);
    expect(points[3]!.trend).toBeCloseTo(100.009, 10);
  });

  it("still carries the trend forward unchanged on days with no reading", () => {
    const points = computeTrend([
      { localDate: day(0), weightKg: 100 },
      { localDate: day(5), weightKg: 96 },
    ]);
    // Days 1-4 hold the seed; only day 5 updates.
    for (const n of [1, 2, 3, 4]) {
      expect(points.find((p) => p.localDate === day(n))!.trend).toBe(100);
    }
    expect(points.at(-1)!.trend).not.toBe(100);
  });
});
