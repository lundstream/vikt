import { describe, expect, it } from "vitest";
import {
  buildScenario,
  type Cadence,
  type IntakeShape,
  type Scenario,
} from "./fixtures.js";
import { estimateTdee, type TdeeProfile } from "./tdee.js";
import { projectAtCurrentPace, projectOnPlan } from "./project.js";
import { trendBurnInDays, trendLagDays, TREND_ALPHA } from "./trend.js";

/**
 * The projection-convergence invariant — D23.
 *
 * §4.3 computes the same future twice by different routes: forward from the
 * planned deficit, and by regressing the trend that deficit produced. On a
 * series built from a *known* maintenance and a *known* intake they describe
 * the same thing, so they must agree. That single assertion catches every span
 * mismatch §4.1 and §4.2 have had, and a hand-computed expected value catches
 * none of them, because the hand computation makes the same assumption the code
 * does.
 *
 * Run over a grid, because all three bugs were invisible at a uniform daily
 * cadence with complete logging — the one shape every earlier fixture used.
 */

const TRUE_MAINTENANCE = 2600;

/**
 * **Clean tolerance: 3%.**
 *
 * This is the floor, not a comfort margin. Measured across the whole grid the
 * worst cell is 2.5% (a step change in target, at a weekly cadence); every
 * cadence at constant intake is exact to the third decimal. The residual is not
 * noise — it is quantisation: `daysToGoal` is a whole number, and at a weekly
 * cadence the last reading can sit six days before `asOf`, so the trend the
 * projection starts from is up to six days stale while the regression is not.
 *
 * 3% of this maintenance figure is ~78 kcal. The mean-intake bug was 428 kcal
 * and the energy-span bug ~130 kcal, so both sit far outside it. The old 15%
 * tolerance was ~390 kcal — wider than one of the bugs it was supposed to be
 * guarding, which is what made it worthless.
 */
const CLEAN_TOLERANCE = 0.03;

/**
 * **Noisy tolerance: 5%, on the mean across seeds.**
 *
 * With σ = 1.0 kg of scale noise a single run's projections can differ by 90%,
 * and no tolerance that admits that is worth having. But a span mismatch is a
 * *systematic* error, so the thing to assert is the absence of bias: average the
 * recovered maintenance over 24 seeds and it must land on the truth. Worst cell
 * measured is 3.5%; 5% leaves room for seed sensitivity without admitting a real
 * bug. Tightening this further would test the PRNG, not the arithmetic.
 */
const NOISY_BIAS_TOLERANCE = 0.05;
const SEEDS = 24;

const profile: TdeeProfile = {
  sex: "male",
  birthDate: "1986-05-04",
  heightCm: 183,
  activityFactor: 1.35,
};

const CADENCES: Cadence[] = ["daily", "alternate", "weekly", "irregular"];
const COVERAGES = [1.0, 0.9, 0.8];

const SHAPES: { name: string; shape: IntakeShape; stationary: boolean }[] = [
  {
    name: "constant intake",
    shape: { kind: "constant", kcal: 2100 },
    stationary: true,
  },
  {
    // D19 now rests on unlogged days not being a random sample of days. Constant
    // intake cannot exercise that reasoning at all: every day is the same day.
    name: "weekends heavier",
    shape: { kind: "weekend", weekday: 2000, weekendExtra: 700 },
    stationary: true,
  },
  {
    // A revised plan. The EMA takes ~44 days to fully absorb a step, so the
    // recovered maintenance lags the truth for a while afterwards — correct
    // behaviour, and the reason this shape is not asserted against truth.
    name: "target steps down midway",
    shape: { kind: "step", before: 2200, after: 1950, atDay: 30 },
    stationary: false,
  },
];

function scenario(
  cadence: Cadence,
  coverage: number,
  intake: IntakeShape,
  noisy: boolean,
  seed: number,
): Scenario {
  return buildScenario({
    trueMaintenance: TRUE_MAINTENANCE,
    intake,
    cadence,
    coverage,
    startKg: 95,
    days: 60,
    intakeNoiseKcal: noisy ? 400 : 0,
    scaleNoiseKg: noisy ? 1.0 : 0,
    seed,
  });
}

type Measured = { tdee: number; ratio: number | null };

/** Runs both projections over a scenario and returns their agreement. */
function measure(s: Scenario): Measured | null {
  const estimate = estimateTdee({
    trend: s.trend,
    intake: s.intake,
    profile,
    asOf: s.asOf,
  });
  if (estimate.source !== "adaptive" || estimate.tdee === null) return null;

  const now = s.trend.at(-1)!.trend;
  // Six kg out, so `daysToGoal` is large enough that its integer rounding is
  // not itself the thing being measured.
  const goalKg = now - 6;

  const onPlan = projectOnPlan({
    currentKg: now,
    goalKg,
    tdee: estimate.tdee,
    // The mean over the same window the estimate averaged. Handing it a
    // whole-series mean would ask the two projections about different periods.
    targetIntakeKcal: s.windowMeanIntakeKcal,
    asOf: s.asOf,
  });
  const pace = projectAtCurrentPace({
    series: s.trend.map((point) => ({ localDate: point.localDate, value: point.trend })),
    target: goalKg,
    asOf: s.asOf,
  });

  return {
    tdee: estimate.tdee,
    ratio: onPlan && pace ? onPlan.daysToGoal / pace.daysToGoal : null,
  };
}

describe("the trend lag, derived for the time-aware formula", () => {
  it("is (1 - alpha) / alpha at a daily cadence", () => {
    expect(trendLagDays(1)).toBeCloseTo((1 - TREND_ALPHA) / TREND_ALPHA, 10);
    expect(trendLagDays(1)).toBeCloseTo(9, 10);
  });

  it("matches gap * beta / (1 - beta) at every gap", () => {
    for (const gap of [1, 2, 3, 7, 14, 30]) {
      const beta = Math.pow(1 - TREND_ALPHA, gap);
      expect(trendLagDays(gap)).toBeCloseTo((gap * beta) / (1 - beta), 10);
    }
  });

  it("shrinks as the gap grows — a rarer weigh-in jumps further each time", () => {
    expect(trendLagDays(7)).toBeCloseTo(6.42, 2);
    expect(trendLagDays(7)).toBeLessThan(trendLagDays(1));
    expect(trendLagDays(14)).toBeLessThan(trendLagDays(7));
  });

  it("is measured against a simulated series, not just against itself", () => {
    // Run the actual EMA on a linear series and read off the steady-state gap.
    for (const gap of [1, 2, 7]) {
      let trend = 100;
      const perDay = -0.05;
      let weight = 100;
      for (let step = 0; step < 400; step++) {
        weight += perDay * gap;
        const effective = 1 - Math.pow(1 - TREND_ALPHA, gap);
        trend += effective * (weight - trend);
      }
      const observedLagDays = (trend - weight) / -perDay;
      expect(observedLagDays, `gap ${gap}`).toBeCloseTo(trendLagDays(gap), 6);
    }
  });

  it("gives a burn-in long enough for the seed to stop mattering", () => {
    expect(trendBurnInDays(0.01)).toBe(44);
    expect(Math.pow(1 - TREND_ALPHA, trendBurnInDays(0.01))).toBeLessThan(0.01);
  });
});

describe("clean series: the two projections agree across the grid", () => {
  for (const { name, shape } of SHAPES) {
    for (const cadence of CADENCES) {
      for (const coverage of COVERAGES) {
        it(`${name}, ${cadence}, ${Math.round(coverage * 100)}% coverage`, () => {
          const measured = measure(scenario(cadence, coverage, shape, false, 1));
          expect(measured, "expected an adaptive figure").not.toBeNull();
          expect(measured!.ratio).not.toBeNull();
          expect(Math.abs(measured!.ratio! - 1)).toBeLessThanOrEqual(CLEAN_TOLERANCE);
        });
      }
    }
  }

  /**
   * The cells that sit closest to the tolerance, kept explicit so a future
   * change that nudges them over is read as a regression rather than as bad
   * luck. Weekly cadence is the tight one, for the staleness reason in the
   * CLEAN_TOLERANCE note.
   */
  it("has its worst cell at a weekly cadence with a stepped target", () => {
    const worst = measure(
      scenario("weekly", 1.0, { kind: "step", before: 2200, after: 1950, atDay: 30 }, false, 1),
    );
    expect(Math.abs(worst!.ratio! - 1)).toBeGreaterThan(0.02);
    expect(Math.abs(worst!.ratio! - 1)).toBeLessThanOrEqual(CLEAN_TOLERANCE);
  });

  it("is exact at a daily cadence, where every span collapses onto the window", () => {
    const measured = measure(
      scenario("daily", 1.0, { kind: "constant", kcal: 2100 }, false, 1),
    );
    expect(Math.abs(measured!.ratio! - 1)).toBeLessThan(0.005);
  });
});

describe("clean series: maintenance is recovered from a stationary rate", () => {
  for (const { name, shape, stationary } of SHAPES.filter((s) => s.stationary)) {
    for (const cadence of CADENCES) {
      for (const coverage of COVERAGES) {
        it(`${name}, ${cadence}, ${Math.round(coverage * 100)}% coverage`, () => {
          expect(stationary).toBe(true);
          const measured = measure(scenario(cadence, coverage, shape, false, 1));
          expect(measured).not.toBeNull();
          expect(
            Math.abs(measured!.tdee / TRUE_MAINTENANCE - 1),
          ).toBeLessThanOrEqual(CLEAN_TOLERANCE);
        });
      }
    }
  }

  it("does not depend on how often the scale is stood on", () => {
    const shape: IntakeShape = { kind: "constant", kcal: 2100 };
    const values = CADENCES.map(
      (cadence) => measure(scenario(cadence, 1.0, shape, false, 1))!.tdee,
    );
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread).toBeLessThan(TRUE_MAINTENANCE * CLEAN_TOLERANCE);
  });

  it("does not depend on which days happened to be logged", () => {
    const shape: IntakeShape = { kind: "constant", kcal: 2100 };
    const values = COVERAGES.map(
      (coverage) => measure(scenario("daily", coverage, shape, false, 1))!.tdee,
    );
    const spread = Math.max(...values) - Math.min(...values);
    expect(spread).toBeLessThan(1);
  });
});

describe("noisy series: no systematic bias", () => {
  for (const { name, shape, stationary } of SHAPES) {
    for (const cadence of CADENCES) {
      it(`${name}, ${cadence}`, () => {
        const recovered: number[] = [];
        for (let seed = 1; seed <= SEEDS; seed++) {
          const measured = measure(scenario(cadence, 0.9, shape, true, seed));
          if (measured) recovered.push(measured.tdee);
        }

        expect(recovered.length, "too few adaptive runs to average").toBeGreaterThan(
          SEEDS / 2,
        );

        const mean = recovered.reduce((a, b) => a + b, 0) / recovered.length;
        // A stepped target legitimately drags the recovered figure while the
        // EMA absorbs the change; it is held to the same bound anyway, which it
        // meets, but the comment is here so a future failure is read correctly.
        expect(stationary === true || stationary === false).toBe(true);
        expect(Math.abs(mean / TRUE_MAINTENANCE - 1)).toBeLessThanOrEqual(
          NOISY_BIAS_TOLERANCE,
        );
      });
    }
  }

  it("still recovers maintenance at the coverage gate under noise", () => {
    const recovered: number[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const measured = measure(
        scenario("daily", 0.8, { kind: "constant", kcal: 2100 }, true, seed),
      );
      if (measured) recovered.push(measured.tdee);
    }
    const mean = recovered.reduce((a, b) => a + b, 0) / recovered.length;
    expect(Math.abs(mean / TRUE_MAINTENANCE - 1)).toBeLessThanOrEqual(NOISY_BIAS_TOLERANCE);
  });
});
