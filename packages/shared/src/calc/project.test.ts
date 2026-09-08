import { describe, expect, it } from "vitest";
import { addDays } from "./trend.js";
import {
  metricKind,
  projectCounted,
  FLAT_SLOPE_EPSILON,
  leastSquares,
  MAX_PROJECTION_DAYS,
  projectAtCurrentPace,
  projectOnPlan,
  type SeriesPoint,
} from "./project.js";

/** Fixtures for CLAUDE.md §4.3, hand-checked. */

const START = "2026-01-01";
const day = (n: number) => addDays(START, n);

/** A straight series, `slope` units per day. */
function line(days: number, from: number, slope: number): SeriesPoint[] {
  return Array.from({ length: days }, (_, i) => ({
    localDate: day(i),
    value: from + i * slope,
  }));
}

describe('"on plan" — the deficit projection', () => {
  it("is (current - goal) * 7700 / (tdee - target), hand-checked", () => {
    // 5 kg to go, 500 kcal/day deficit -> 5 * 7700 / 500 = 77 days.
    const projection = projectOnPlan({
      currentKg: 90,
      goalKg: 85,
      tdee: 2500,
      targetIntakeKcal: 2000,
      asOf: day(0),
    });
    expect(projection).not.toBeNull();
    expect(projection!.daysToGoal).toBe(77);
    expect(projection!.targetDate).toBe(addDays(day(0), 77));
    expect(projection!.alreadyThere).toBe(false);
  });

  it("returns zero days when the goal is already met, not a negative number", () => {
    const projection = projectOnPlan({
      currentKg: 84,
      goalKg: 85,
      tdee: 2500,
      targetIntakeKcal: 2000,
      asOf: day(0),
    });
    expect(projection).toEqual({ daysToGoal: 0, targetDate: day(0), alreadyThere: true });
  });

  it("returns null when eating at maintenance — no deficit, no date", () => {
    expect(
      projectOnPlan({
        currentKg: 90,
        goalKg: 85,
        tdee: 2000,
        targetIntakeKcal: 2000,
        asOf: day(0),
      }),
    ).toBeNull();
  });

  it("returns null when eating above maintenance, never a negative date", () => {
    expect(
      projectOnPlan({
        currentKg: 90,
        goalKg: 85,
        tdee: 2000,
        targetIntakeKcal: 2600,
        asOf: day(0),
      }),
    ).toBeNull();
  });

  it('returns null when there is no TDEE at all (source "none")', () => {
    expect(
      projectOnPlan({
        currentKg: 90,
        goalKg: 85,
        tdee: null,
        targetIntakeKcal: 2000,
        asOf: day(0),
      }),
    ).toBeNull();
  });

  it("returns null rather than a date beyond the horizon", () => {
    // 30 kg on a 50 kcal deficit is 4620 days. A date in 2038 is not information.
    const projection = projectOnPlan({
      currentKg: 120,
      goalKg: 90,
      tdee: 2050,
      targetIntakeKcal: 2000,
      asOf: day(0),
    });
    expect(projection).toBeNull();
  });

  it("never emits a non-finite day count", () => {
    for (const tdee of [Number.POSITIVE_INFINITY, Number.NaN]) {
      const projection = projectOnPlan({
        currentKg: 90,
        goalKg: 85,
        tdee,
        targetIntakeKcal: 2000,
        asOf: day(0),
      });
      if (projection) expect(Number.isFinite(projection.daysToGoal)).toBe(true);
    }
  });
});

describe('"at current pace" — the least-squares projection', () => {
  it("extrapolates a clean 28-day loss, hand-checked", () => {
    // -0.05 kg/day from 90. Last value is 90 - 27*0.05 = 88.65.
    // 3.65 kg to reach 85, at 0.05/day -> 73 days.
    const series = line(28, 90, -0.05);
    const projection = projectAtCurrentPace({ series, target: 85, asOf: day(27) });

    expect(projection).not.toBeNull();
    expect(projection!.daysToGoal).toBe(73);
    expect(projection!.targetDate).toBe(addDays(day(27), 73));
  });

  it("returns null for a flat series — §4.3 is explicit about this", () => {
    const series = line(28, 90, 0);
    expect(projectAtCurrentPace({ series, target: 85, asOf: day(27) })).toBeNull();
  });

  it("returns null for a series drifting below the flat threshold", () => {
    const series = line(28, 90, -(FLAT_SLOPE_EPSILON / 2));
    expect(projectAtCurrentPace({ series, target: 85, asOf: day(27) })).toBeNull();
  });

  it("returns null for a rising series when the target is below", () => {
    const series = line(28, 90, 0.04);
    expect(projectAtCurrentPace({ series, target: 85, asOf: day(27) })).toBeNull();
  });

  it("never returns a negative or infinite date for any of those", () => {
    for (const slope of [0, 0.04, -0.0001, 1e-12]) {
      const projection = projectAtCurrentPace({
        series: line(28, 90, slope),
        target: 85,
        asOf: day(27),
      });
      if (projection !== null) {
        expect(Number.isFinite(projection.daysToGoal)).toBe(true);
        expect(projection.daysToGoal).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("returns null rather than a date past the horizon", () => {
    // 0.003 kg/day towards a 5 kg goal is over 1600 days.
    const series = line(28, 90, -0.003);
    expect(projectAtCurrentPace({ series, target: 85, asOf: day(27) })).toBeNull();
  });

  it("fits through noise rather than reading only the endpoints", () => {
    const series = line(28, 90, -0.05).map((point, i) => ({
      ...point,
      // A big spike on the last day must not swing the projection much.
      value: point.value + (i === 27 ? 1.5 : 0),
    }));
    const projection = projectAtCurrentPace({ series, target: 85, asOf: day(27) });
    expect(projection).not.toBeNull();
    expect(projection!.daysToGoal).toBeGreaterThan(40);
  });

  it("needs at least a week before it says anything", () => {
    expect(
      projectAtCurrentPace({ series: line(6, 90, -0.05), target: 85, asOf: day(5) }),
    ).toBeNull();
    expect(
      projectAtCurrentPace({ series: line(7, 90, -0.05), target: 85, asOf: day(6) }),
    ).not.toBeNull();
  });

  it("uses only the last 28 days, ignoring older history", () => {
    // Sixty days: fast loss then a slower stretch. Only the recent slope counts.
    const older = line(32, 100, -0.2);
    const recent = Array.from({ length: 28 }, (_, i) => ({
      localDate: day(32 + i),
      value: older.at(-1)!.value - 0.2 + i * -0.02,
    }));
    const projection = projectAtCurrentPace({
      series: [...older, ...recent],
      target: recent.at(-1)!.value - 1,
      asOf: day(59),
    });
    // At 0.02 kg/day, 1 kg takes 50 days. At the older 0.2, it would be 5.
    expect(projection!.daysToGoal).toBe(50);
  });

  it("ignores points after asOf", () => {
    const series = line(40, 90, -0.05);
    const a = projectAtCurrentPace({ series: series.slice(0, 28), target: 85, asOf: day(27) });
    const b = projectAtCurrentPace({ series, target: 85, asOf: day(27) });
    expect(b).toEqual(a);
  });
});

/**
 * §4.3: "The same function serves milestone projections." Phase 5 regresses a
 * waist series or a streak count through this, so nothing may assume weight or
 * assume the series is falling.
 */
describe("the same function serves other metrics", () => {
  it("projects a falling waist measurement in cm", () => {
    const series = line(28, 104, -0.06);
    const projection = projectAtCurrentPace({ series, target: 100, asOf: day(27) });
    expect(projection).not.toBeNull();
    expect(projection!.daysToGoal).toBeGreaterThan(0);
  });

  it("projects a rising metric towards a target above it", () => {
    // A streak count, or anything else that is supposed to go up.
    const series = line(28, 10, 1);
    const projection = projectAtCurrentPace({ series, target: 60, asOf: day(27) });
    expect(projection).not.toBeNull();
    // Last value is 37, rising 1/day -> 23 days.
    expect(projection!.daysToGoal).toBe(23);
  });

  it("returns null when a rising metric has a target below it", () => {
    const series = line(28, 10, 1);
    expect(projectAtCurrentPace({ series, target: 5, asOf: day(27) })).toBeNull();
  });

  it("says already-there when the target is met", () => {
    const series = line(28, 90, -0.05);
    const projection = projectAtCurrentPace({
      series,
      target: series.at(-1)!.value,
      asOf: day(27),
    });
    expect(projection).toEqual({ daysToGoal: 0, targetDate: day(27), alreadyThere: true });
  });
});

describe("the least-squares fit", () => {
  it("recovers a known slope exactly", () => {
    const fit = leastSquares(line(28, 90, -0.05));
    expect(fit!.slopePerDay).toBeCloseTo(-0.05, 10);
    expect(fit!.intercept).toBeCloseTo(90, 10);
  });

  it("measures in days elapsed, so gaps are not compressed", () => {
    const withGap: SeriesPoint[] = [
      { localDate: day(0), value: 100 },
      { localDate: day(10), value: 99 },
      { localDate: day(20), value: 98 },
    ];
    expect(leastSquares(withGap)!.slopePerDay).toBeCloseTo(-0.1, 10);
  });

  it("returns null for fewer than two points", () => {
    expect(leastSquares([])).toBeNull();
    expect(leastSquares([{ localDate: day(0), value: 90 }])).toBeNull();
  });

  it("returns null when every point is on the same day", () => {
    expect(
      leastSquares([
        { localDate: day(0), value: 90 },
        { localDate: day(0), value: 91 },
      ]),
    ).toBeNull();
  });
});

describe("the projection horizon", () => {
  it("is two years", () => {
    expect(MAX_PROJECTION_DAYS).toBe(730);
  });
});

/**
 * Counted metrics (D79).
 *
 * The defect: a milestone on `sober_days` reported "the series moves too little
 * for a date" about a number that advances by exactly one every day. The
 * regression was not wrong about the data, it was the wrong question.
 */
describe("projecting a counter", () => {
  it("is exact arithmetic, not a fit", () => {
    // Day 28 of 100. The answer is 72, and there is nothing to estimate.
    expect(projectCounted({ current: 28, target: 100, asOf: "2026-09-05" })).toEqual({
      daysToGoal: 72,
      targetDate: "2026-11-16",
      alreadyThere: false,
    });
  });

  /**
   * The case that produced the complaint. A young streak has too few points for
   * the regression's seven-day minimum, so it returned null; here the count
   * being young is not an obstacle, it is the input.
   */
  it("answers on the first day of a streak, where the fit could not", () => {
    const early = projectCounted({ current: 1, target: 30, asOf: "2026-09-05" });
    expect(early?.daysToGoal).toBe(29);

    // What the old path did with the same milestone.
    const fitted = projectAtCurrentPace({
      series: [{ localDate: "2026-09-05", value: 1 }],
      target: 30,
      asOf: "2026-09-05",
    });
    expect(fitted).toBeNull();
  });

  it("reports a target already reached rather than a negative date", () => {
    expect(projectCounted({ current: 120, target: 100, asOf: "2026-09-05" })).toEqual({
      daysToGoal: 0,
      targetDate: "2026-09-05",
      alreadyThere: true,
    });
  });

  it("still refuses a horizon past the cap", () => {
    expect(projectCounted({ current: 0, target: 5000, asOf: "2026-09-05" })).toBeNull();
  });

  it("knows which metrics are counted", () => {
    expect(metricKind("sober_days")).toBe("counted");
    expect(metricKind("log_streak_days")).toBe("counted");
    for (const measured of ["weight_kg", "waist_cm", "chest_cm", "whtr"]) {
      expect(metricKind(measured)).toBe("measured");
    }
  });
});
