import { describe, expect, it } from "vitest";
import { buildIntakeIndex } from "./intake.js";
import { computeTrend, addDays, type TrendPoint } from "./trend.js";
import { projectAtCurrentPace, projectOnPlan } from "./project.js";
import {
  adaptiveConfidence,
  ageOn,
  COVERAGE_GATE,
  estimateTdee,
  FORMULA_CONFIDENCE,
  KCAL_PER_KG,
  MIN_WINDOW_DAYS,
  mifflinStJeor,
  PREFERRED_WINDOW_DAYS,
  type TdeeProfile,
} from "./tdee.js";

/**
 * Fixtures for CLAUDE.md §4.2 and DECISIONS.md D19/D20. Arithmetic is checked
 * against hand-computed values.
 */

const START = "2026-01-01";
const day = (n: number) => addDays(START, n);

const profile: TdeeProfile = {
  sex: "male",
  birthDate: "1986-05-04",
  heightCm: 183,
  activityFactor: 1.35,
};

/** A weight series losing a steady `kgPerDay`, one reading every day. */
function losingSeries(days: number, from = 100, kgPerDay = 0.05) {
  return Array.from({ length: days }, (_, i) => ({
    localDate: day(i),
    weightKg: from - i * kgPerDay,
  }));
}

/** Intake on the first `loggedDays` of `days`, at a flat `kcal`. */
function intakeFor(days: number, kcal: number, loggedDays = days) {
  return buildIntakeIndex({
    manual: Array.from({ length: loggedDays }, (_, i) => ({ localDate: day(i), kcal })),
  });
}

function trendFor(days: number, from?: number, kgPerDay?: number): TrendPoint[] {
  return computeTrend(losingSeries(days, from, kgPerDay));
}

describe("a clean 28-day loss series", () => {
  const days = 28;
  const trend = trendFor(days);
  const asOf = day(days - 1);

  it("returns an adaptive figure", () => {
    const result = estimateTdee({ trend, intake: intakeFor(days, 2000), profile, asOf });
    expect(result.source).toBe("adaptive");
    expect(result.windowDays).toBe(28);
    expect(result.coverage).toBe(1);
  });

  it("computes TDEE exactly as §4.2 specifies", () => {
    const intakeKcal = 2000;
    const result = estimateTdee({
      trend,
      intake: intakeFor(days, intakeKcal),
      profile,
      asOf,
    });

    // Hand-computed from the same window the function used. Every day here has
    // a reading, so the trend spans days 0 to 27 — 27 days, not 28.
    const trendDeltaKg = trend[27]!.trend - trend[0]!.trend;
    const expected = intakeKcal - (trendDeltaKg * 7700) / 27;

    expect(result.tdee).toBeCloseTo(expected, 6);
    // Losing weight on 2000 kcal means maintenance is above 2000.
    expect(result.tdee!).toBeGreaterThan(intakeKcal);
  });

  it("scores full confidence only here, at full coverage over the full window", () => {
    const result = estimateTdee({ trend, intake: intakeFor(days, 2000), profile, asOf });
    expect(result.confidence).toBe(1);
  });

  it("needs no profile fields at all — adaptive beats formula", () => {
    const bare: TdeeProfile = {
      sex: "unspecified",
      birthDate: null,
      heightCm: 183,
      activityFactor: 1.35,
    };
    const result = estimateTdee({
      trend,
      intake: intakeFor(days, 2000),
      profile: bare,
      asOf,
    });
    expect(result.source).toBe("adaptive");
    expect(result.missing).toEqual([]);
  });
});

describe("the coverage gate", () => {
  const days = 28;
  const trend = trendFor(days);
  const asOf = day(days - 1);

  const at = (loggedDays: number) =>
    estimateTdee({ trend, intake: intakeFor(days, 2000, loggedDays), profile, asOf });

  it("falls back to formula at 60% coverage", () => {
    const result = at(17); // 17/28 = 0.607
    expect(result.coverage).toBeCloseTo(17 / 28, 6);
    expect(result.coverage).toBeLessThan(COVERAGE_GATE);
    expect(result.source).toBe("formula");
  });

  /**
   * The boundary, pinned from both sides. 22/28 = 0.7857 is under the gate and
   * 23/28 = 0.8214 is over it; there is no whole number of days that lands
   * exactly on 0.8 in a 28-day window, so the pair brackets it.
   */
  it("refuses adaptive just below the gate (79%)", () => {
    const result = at(22);
    expect(result.coverage).toBeCloseTo(0.7857, 4);
    expect(result.source).toBe("formula");
    expect(result.blockedBy).toBe("coverage");
  });

  it("allows adaptive just above the gate (81%)", () => {
    const result = at(23);
    expect(result.coverage).toBeCloseTo(0.8214, 4);
    expect(result.source).toBe("adaptive");
  });

  it("allows adaptive exactly on the gate", () => {
    // A 20-day window with 16 logged is exactly 0.80.
    const shortTrend = trendFor(20);
    const result = estimateTdee({
      trend: shortTrend,
      intake: intakeFor(20, 2000, 16),
      profile,
      asOf: day(19),
    });
    expect(result.coverage).toBe(0.8);
    expect(result.source).toBe("adaptive");
  });

  it("counts a 0 kcal day as logged, not as missing", () => {
    const intake = buildIntakeIndex({
      manual: Array.from({ length: 28 }, (_, i) => ({
        localDate: day(i),
        kcal: i === 5 ? 0 : 2000,
      })),
    });
    const result = estimateTdee({ trend, intake, profile, asOf });
    expect(result.coverage).toBe(1);
    expect(result.source).toBe("adaptive");
  });
});

describe("a 13-day series, below the minimum window", () => {
  const days = 13;
  const trend = trendFor(days);
  const asOf = day(days - 1);

  it("does not return an adaptive figure however complete the logging", () => {
    const result = estimateTdee({ trend, intake: intakeFor(days, 2000), profile, asOf });
    expect(result.coverage).toBe(1);
    expect(result.source).not.toBe("adaptive");
    expect(result.windowDays).toBe(13);
  });

  it("says it is waiting on history, and for how long", () => {
    const result = estimateTdee({ trend, intake: intakeFor(days, 2000), profile, asOf });
    expect(result.blockedBy).toBe("history");
    expect(result.daysUntilAdaptive).toBe(MIN_WINDOW_DAYS - 13);
  });

  it("turns adaptive on the fourteenth day", () => {
    const result = estimateTdee({
      trend: trendFor(14),
      intake: intakeFor(14, 2000),
      profile,
      asOf: day(13),
    });
    expect(result.source).toBe("adaptive");
    expect(result.windowDays).toBe(MIN_WINDOW_DAYS);
  });
});

describe("a profile missing sex and birth date", () => {
  const bare: TdeeProfile = {
    sex: "unspecified",
    birthDate: null,
    heightCm: 183,
    activityFactor: 1.35,
  };
  // Enough history for a window, too little coverage for adaptive.
  const trend = trendFor(28);
  const asOf = day(27);
  const result = estimateTdee({ trend, intake: intakeFor(28, 2000, 10), profile: bare, asOf });

  it('returns source "none" rather than a guessed number (D20)', () => {
    expect(result.source).toBe("none");
    expect(result.tdee).toBeNull();
  });

  it("scores zero confidence", () => {
    expect(result.confidence).toBe(0);
  });

  it("names exactly the fields the UI should ask for", () => {
    expect(result.missing).toEqual(["sex", "birthDate"]);
  });

  it("names only the field that is actually missing", () => {
    const halfKnown = estimateTdee({
      trend,
      intake: intakeFor(28, 2000, 10),
      profile: { ...bare, sex: "female" },
      asOf,
    });
    expect(halfKnown.missing).toEqual(["birthDate"]);
  });

  it("reports source none when there is no weight either", () => {
    const result = estimateTdee({
      trend: [],
      intake: buildIntakeIndex({}),
      profile: bare,
      asOf,
    });
    expect(result.source).toBe("none");
    expect(result.missing).toContain("weightKg");
  });
});

describe("the formula fallback", () => {
  const trend = trendFor(28, 100, 0);
  const asOf = day(27);

  it("is Mifflin-St Jeor times the activity factor", () => {
    const result = estimateTdee({
      trend,
      intake: intakeFor(28, 2000, 10),
      profile,
      asOf,
    });

    // 10*100 + 6.25*183 - 5*age + 5, times 1.35.
    const age = ageOn(profile.birthDate!, asOf)!;
    const bmr = 10 * 100 + 6.25 * 183 - 5 * age + 5;
    expect(result.source).toBe("formula");
    expect(result.tdee).toBeCloseTo(bmr * 1.35, 6);
  });

  it("uses the female offset for a female profile", () => {
    const male = mifflinStJeor({ profile, weightKg: 100, asOf });
    const female = mifflinStJeor({
      profile: { ...profile, sex: "female" },
      weightKg: 100,
      asOf,
    });
    expect(male.tdee! - female.tdee!).toBe(166); // +5 against -161
  });

  it("carries a fixed low confidence that never ramps", () => {
    const sparse = estimateTdee({ trend, intake: intakeFor(28, 2000, 5), profile, asOf });
    const less = estimateTdee({ trend, intake: intakeFor(28, 2000, 20), profile, asOf });
    expect(sparse.confidence).toBe(FORMULA_CONFIDENCE);
    expect(less.confidence).toBe(FORMULA_CONFIDENCE);
  });

  it("stays well below any adaptive figure's confidence", () => {
    const adaptive = estimateTdee({ trend, intake: intakeFor(28, 2000), profile, asOf });
    expect(FORMULA_CONFIDENCE).toBeLessThan(adaptive.confidence);
  });
});

describe("the confidence ramp (D19)", () => {
  it("is 0 at the worst admissible case: the gate, over the minimum window", () => {
    expect(adaptiveConfidence(COVERAGE_GATE, MIN_WINDOW_DAYS)).toBe(0);
  });

  it("is 1 only at full coverage over the full window", () => {
    expect(adaptiveConfidence(1, PREFERRED_WINDOW_DAYS)).toBe(1);
    expect(adaptiveConfidence(1, MIN_WINDOW_DAYS)).toBeLessThan(1);
    expect(adaptiveConfidence(COVERAGE_GATE, PREFERRED_WINDOW_DAYS)).toBeLessThan(1);
  });

  it("is monotonic in coverage", () => {
    let previous = -1;
    for (let coverage = COVERAGE_GATE; coverage <= 1.0001; coverage += 0.01) {
      const value = adaptiveConfidence(Math.min(coverage, 1), 21);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("is monotonic in window length", () => {
    let previous = -1;
    for (let days = MIN_WINDOW_DAYS; days <= PREFERRED_WINDOW_DAYS; days++) {
      const value = adaptiveConfidence(0.9, days);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  /**
   * Even, since D19 was re-derived. The old 0.7/0.3 split rested on missing
   * days biasing the intake mean low, which was an arithmetic error in §4.2
   * rather than a property of the data; with that fixed, coverage and window
   * length contribute errors of the same order.
   */
  it("weights coverage and window length evenly", () => {
    expect(adaptiveConfidence(1, MIN_WINDOW_DAYS)).toBeCloseTo(
      adaptiveConfidence(COVERAGE_GATE, PREFERRED_WINDOW_DAYS),
      10,
    );
  });

  it("hand-checked: 0.5 * coverageTerm + 0.5 * lengthTerm", () => {
    // coverage 0.9 -> (0.9-0.8)/0.2 = 0.5 ; 21 days -> (21-14)/14 = 0.5
    expect(adaptiveConfidence(0.9, 21)).toBeCloseTo(0.5, 10);
    // coverage 1.0 -> 1 ; 14 days -> 0
    expect(adaptiveConfidence(1, 14)).toBeCloseTo(0.5, 10);
    // coverage 0.8 -> 0 ; 28 days -> 1
    expect(adaptiveConfidence(0.8, 28)).toBeCloseTo(0.5, 10);
  });

  it("stays inside 0..1 for nonsense inputs", () => {
    expect(adaptiveConfidence(-5, 0)).toBe(0);
    expect(adaptiveConfidence(99, 999)).toBe(1);
    expect(adaptiveConfidence(Number.NaN, 21)).toBe(0);
  });
});

describe("age", () => {
  it("counts whole years", () => {
    expect(ageOn("1986-05-04", "2026-05-04")).toBe(40);
    expect(ageOn("1986-05-04", "2026-05-03")).toBe(39);
    expect(ageOn("1986-05-04", "2026-05-05")).toBe(40);
  });

  it("refuses a birth date in the future", () => {
    expect(ageOn("2030-01-01", "2026-01-01")).toBeNull();
  });
});

/**
 * The regression for the §4.2 denominator bug.
 *
 * `meanIntake` used to divide by `daysInWindow`, so an unlogged day counted as
 * a day of zero calories. At 82% coverage that made maintenance ~18% light —
 * about 320 kcal on a 2400 kcal figure — with nothing on screen looking wrong.
 */
describe("adaptive TDEE is not distorted by which days were logged", () => {
  const days = 28;
  const trend = trendFor(days);
  const asOf = day(days - 1);
  const kcal = 2400;

  const full = estimateTdee({ trend, intake: intakeFor(days, kcal), profile, asOf });

  /** The same intake, with `missing` days dropped from the middle of the window. */
  function withGaps(missing: number) {
    const skip = new Set<number>();
    // Spread the gaps out rather than clumping them at one end.
    for (let i = 0; i < missing; i++) skip.add(Math.floor((i + 0.5) * (days / missing)));
    return buildIntakeIndex({
      manual: Array.from({ length: days }, (_, i) => ({ localDate: day(i), kcal }))
        .filter((_, i) => !skip.has(i)),
    });
  }

  it("gives the same answer at 100% and at 82% coverage, within 1 kcal", () => {
    // 5 of 28 days dropped is 82.1% coverage, just above the gate.
    const sparse = estimateTdee({ trend, intake: withGaps(5), profile, asOf });

    expect(sparse.coverage).toBeCloseTo(23 / 28, 4);
    expect(sparse.source).toBe("adaptive");
    expect(sparse.tdee!).toBeCloseTo(full.tdee!, 0);
    // The tolerance that matters: nowhere near the ~430 kcal the bug produced.
    expect(Math.abs(sparse.tdee! - full.tdee!)).toBeLessThan(1);
  });

  it("holds across every admissible coverage level", () => {
    for (const missing of [1, 2, 3, 4, 5]) {
      const sparse = estimateTdee({ trend, intake: withGaps(missing), profile, asOf });
      expect(sparse.source, `${missing} missing`).toBe("adaptive");
      expect(Math.abs(sparse.tdee! - full.tdee!), `${missing} missing`).toBeLessThan(1);
    }
  });

  it("averages intake over the days logged, not over the window", () => {
    // A window where every logged day is 2400 must report mean intake 2400,
    // whatever the coverage. With a flat weight series the energy term is zero,
    // so TDEE is exactly the mean.
    const flat = trendFor(days, 100, 0);
    const sparse = estimateTdee({ trend: flat, intake: withGaps(5), profile, asOf });
    expect(sparse.tdee!).toBeCloseTo(kcal, 6);
  });
});

/**
 * The invariant that would have caught the denominator bug on its own.
 *
 * Build a synthetic month from a *known* maintenance and a *known* intake, so
 * the weight series is the exact consequence of the energy balance. Then the two
 * projections in §4.3 are computing the same future by different routes — one
 * from the deficit, one by regressing the resulting trend — and they must agree.
 *
 * They disagreed by a factor of 4.9 while §4.2 was wrong. This guards every
 * future change to either formula.
 */
describe("the two projections converge on a synthetic series", () => {
  const TRUE_MAINTENANCE = 2600;
  const INTAKE = 2100;
  const days = 60;
  const startKg = 95;

  // Energy balance: a 500 kcal/day deficit is 500/7700 kg/day.
  const kgPerDay = (INTAKE - TRUE_MAINTENANCE) / KCAL_PER_KG;
  const readings = Array.from({ length: days }, (_, i) => ({
    localDate: day(i),
    weightKg: startKg + i * kgPerDay,
  }));
  const trend = computeTrend(readings);
  const asOf = day(days - 1);
  const intake = buildIntakeIndex({
    manual: Array.from({ length: days }, (_, i) => ({ localDate: day(i), kcal: INTAKE })),
  });

  const result = estimateTdee({ trend, intake, profile, asOf });

  it("recovers the maintenance it was built from, within 2%", () => {
    expect(result.source).toBe("adaptive");
    expect(result.tdee!).toBeGreaterThan(TRUE_MAINTENANCE * 0.98);
    expect(result.tdee!).toBeLessThan(TRUE_MAINTENANCE * 1.02);
  });

  /**
   * The ratio of the two projections, for a given intake index.
   *
   * Run at several coverage levels on purpose. At 100% coverage the two
   * denominators in §4.2 are the same number, so the bug this guards against is
   * invisible; it only shows once days are missing, which is every real
   * account. A convergence test at full coverage alone would have passed
   * happily while the dashboard was 18% wrong.
   */
  function projectionRatio(intakeIndex: ReturnType<typeof buildIntakeIndex>) {
    const estimate = estimateTdee({ trend, intake: intakeIndex, profile, asOf });
    const goalKg = trend.at(-1)!.trend - 3;

    const onPlan = projectOnPlan({
      currentKg: trend.at(-1)!.trend,
      goalKg,
      tdee: estimate.tdee,
      targetIntakeKcal: INTAKE,
      asOf,
    });
    const pace = projectAtCurrentPace({
      series: trend.map((p) => ({ localDate: p.localDate, value: p.trend })),
      target: goalKg,
      asOf,
    });

    expect(estimate.source).toBe("adaptive");
    expect(onPlan).not.toBeNull();
    expect(pace).not.toBeNull();
    return onPlan!.daysToGoal / pace!.daysToGoal;
  }

  /**
   * Everything logged except `dropped` days spread through the **last 28**,
   * which is the window `estimateTdee` actually uses. Spreading gaps across all
   * 60 days instead would quietly push in-window coverage under the gate and
   * turn the estimate into a formula fallback, testing nothing.
   */
  function partialIntake(dropped: number) {
    const windowStart = days - PREFERRED_WINDOW_DAYS;
    const skip = new Set<number>();
    for (let i = 0; i < dropped; i++) {
      skip.add(windowStart + Math.floor((i + 0.5) * (PREFERRED_WINDOW_DAYS / dropped)));
    }
    return buildIntakeIndex({
      manual: Array.from({ length: days }, (_, i) => ({ localDate: day(i), kcal: INTAKE }))
        .filter((_, i) => !skip.has(i)),
    });
  }

  it("agrees between 'on plan' and 'at current pace' at full coverage", () => {
    const ratio = projectionRatio(intake);
    // Tolerance: the EMA lags a linear series by ~1/alpha days, so the regressed
    // pace is fractionally shallower than the true one. 15% covers that with
    // room to spare, and is far tighter than the 4.9x the bug produced.
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it("agrees at 82% coverage too — the level the bug was found at", () => {
    // 5 of the 28 in-window days dropped: 23/28 = 82.1%.
    const ratio = projectionRatio(partialIntake(5));
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it("agrees at every admissible coverage level", () => {
    for (const dropped of [1, 2, 3, 4, 5]) {
      const ratio = projectionRatio(partialIntake(dropped));
      expect(ratio, `${dropped} days dropped`).toBeGreaterThan(0.85);
      expect(ratio, `${dropped} days dropped`).toBeLessThan(1.15);
    }
  });

  it("would have failed loudly on the old denominator", () => {
    // Reproduce the bug: divide the same total by the window rather than by the
    // days logged, at the coverage the seeded account actually had.
    const logged = 23;
    const sparse = buildIntakeIndex({
      manual: Array.from({ length: logged }, (_, i) => ({
        localDate: day(days - logged + i),
        kcal: INTAKE,
      })),
    });
    const correct = estimateTdee({ trend, intake: sparse, profile, asOf });
    const buggy = (correct.tdee! - INTAKE) + (INTAKE * logged) / 28;

    expect(correct.tdee!).toBeGreaterThan(TRUE_MAINTENANCE * 0.95);
    // The old arithmetic lands ~18% low, which is what was on the dashboard.
    expect(buggy).toBeLessThan(TRUE_MAINTENANCE * 0.9);
  });
});

/**
 * TDEE against a weekly weigh-in.
 *
 * The trend delta is the whole energy term, so a trend that under-reports
 * movement under-reports the deficit and over-reports maintenance. Before §4.1
 * was made time-aware, a weekly series showed about a seventh of the real
 * change, which pushed maintenance towards mean intake and made every plan look
 * like it was barely working.
 */
describe("weekly weigh-ins", () => {
  const TRUE_MAINTENANCE = 2600;
  const INTAKE = 2100;
  const days = 56;
  const kgPerDay = (INTAKE - TRUE_MAINTENANCE) / KCAL_PER_KG;

  /** Readings every `cadence` days, on the same underlying weight curve. */
  function seriesAt(cadence: number) {
    const readings = [];
    for (let i = 0; i < days; i += cadence) {
      readings.push({ localDate: day(i), weightKg: 95 + i * kgPerDay });
    }
    return computeTrend(readings, { to: day(days - 1) });
  }

  const intake = buildIntakeIndex({
    manual: Array.from({ length: days }, (_, i) => ({ localDate: day(i), kcal: INTAKE })),
  });
  const asOf = day(days - 1);

  it("recovers maintenance from weekly readings, within 1%", () => {
    const result = estimateTdee({ trend: seriesAt(7), intake, profile, asOf });
    expect(result.source).toBe("adaptive");
    expect(result.tdee!).toBeGreaterThan(TRUE_MAINTENANCE * 0.99);
    expect(result.tdee!).toBeLessThan(TRUE_MAINTENANCE * 1.01);
  });

  it("gives roughly the same answer at daily, every-other-day and weekly cadence", () => {
    const daily = estimateTdee({ trend: seriesAt(1), intake, profile, asOf }).tdee!;
    const alternate = estimateTdee({ trend: seriesAt(2), intake, profile, asOf }).tdee!;
    const weekly = estimateTdee({ trend: seriesAt(7), intake, profile, asOf }).tdee!;

    // How often you stand on the scale must not change what maintenance is.
    for (const [label, value] of [
      ["every other day", alternate],
      ["weekly", weekly],
    ] as const) {
      expect(Math.abs(value - daily), label).toBeLessThan(daily * 0.01);
    }
  });

  it("does not push maintenance towards mean intake", () => {
    // The failure mode of the old per-reading alpha: a stalled trend makes the
    // energy term vanish and TDEE collapses onto the intake figure.
    const result = estimateTdee({ trend: seriesAt(7), intake, profile, asOf });
    expect(result.tdee! - INTAKE).toBeGreaterThan(400);
  });
});

/**
 * Estimates and the coverage gate (D82).
 *
 * The decision this pins: **an estimated day is a logged day**, and it pays for
 * itself in confidence rather than in exclusion. Excluding estimates would drop
 * coverage below the gate for anyone who eats out regularly, losing the adaptive
 * figure entirely — and restaurant days are exactly the days that differ from
 * the rest, so dropping them recreates the bias the gate exists to prevent.
 */
describe("a window containing estimates", () => {
  const days = 28;
  const trend = Array.from({ length: days }, (_, i) => ({
    localDate: addDays("2026-08-08", i),
    raw: 90 - i * 0.02,
    trend: 90 - i * 0.02,
    interpolated: false,
  }));
  const intake = buildIntakeIndex({
    manual: trend.map((point) => ({ localDate: point.localDate, kcal: 2000 })),
    foodEntries: [],
  });
  const profile = {
    heightCm: 180,
    birthDate: "1985-01-01",
    sex: "male" as const,
    activityFactor: 1.35,
  };
  const asOf = trend[trend.length - 1]!.localDate;

  const run = (estimatedKcal?: number) =>
    estimateTdee({ trend, intake, profile, asOf, estimatedKcal });

  it("still produces an adaptive figure when every day was estimated", () => {
    const all = run(2000 * days);
    expect(all.source).toBe("adaptive");
    expect(all.coverage).toBe(1);
    // The number is the same number: estimates move confidence, not the mean.
    expect(all.tdee).toBeCloseTo(run(0).tdee!, 6);
  });

  it("reports how much of the window was guessed at", () => {
    expect(run(0).estimateShare).toBe(0);
    expect(run(2000 * 7).estimateShare).toBeCloseTo(0.25, 6);
    expect(run(2000 * days).estimateShare).toBe(1);
  });

  /** The boundary the decision turns on, stated as arithmetic. */
  it("charges the confidence in proportion, and halves it at the extreme", () => {
    const clean = run(0).confidence;
    expect(run(2000 * days).confidence).toBeCloseTo(clean * 0.5, 6);
    expect(run(2000 * 14).confidence).toBeCloseTo(clean * 0.75, 6);
    // Reduced, never zero: an all-estimate window still measures something.
    expect(run(2000 * days).confidence).toBeGreaterThan(0);
  });

  it("leaves a formula figure alone, which estimates could not have moved", () => {
    const short = trend.slice(-10);
    const result = estimateTdee({
      trend: short,
      intake,
      profile,
      asOf,
      estimatedKcal: 2000 * 10,
    });
    expect(result.source).toBe("formula");
    expect(result.confidence).toBe(FORMULA_CONFIDENCE);
  });

  it("treats an unsupplied figure as no estimates at all", () => {
    expect(run(undefined).estimateShare).toBe(0);
    expect(run(undefined).confidence).toBe(run(0).confidence);
  });
});
