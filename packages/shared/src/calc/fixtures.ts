import { addDays, computeTrend, eachDay, trendBurnInDays, type TrendPoint } from "./trend.js";
import { buildIntakeIndex, intakeOn, type IntakeIndex } from "./intake.js";
import { PREFERRED_WINDOW_DAYS } from "./tdee.js";

/**
 * Synthetic series for the projection-convergence invariant.
 *
 * Every bug §4.1 and §4.2 have had was a span mismatch, and span mismatches are
 * invisible at a uniform daily cadence with complete logging (D23). So these
 * generators exist to make cadence, coverage and intake shape all vary, and to
 * do it deterministically.
 *
 * Not test-only: kept beside the calc functions so the grid is written against
 * the same module the app uses, and so a future phase can reuse the generator
 * rather than inventing a second one that drifts.
 */

/** Deterministic PRNG. Seeded so a failing grid cell is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so the noise is actually Gaussian rather than uniform. */
export function gaussian(random: () => number): number {
  const u = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

export type Cadence = "daily" | "alternate" | "weekly" | "irregular";

/** Whether day `i` carries a weigh-in. */
export function weighsIn(cadence: Cadence, dayIndex: number, random: () => number): boolean {
  switch (cadence) {
    case "daily":
      return true;
    case "alternate":
      return dayIndex % 2 === 0;
    case "weekly":
      return dayIndex % 7 === 0;
    case "irregular":
      // Roughly every other day, but clustered — real people weigh in three
      // days running and then forget for five.
      return random() < 0.5;
  }
}

export type IntakeShape =
  | { kind: "constant"; kcal: number }
  /** Target drops partway through, as it does when a plan is revised. */
  | { kind: "step"; before: number; after: number; atDay: number }
  /** Saturdays and Sundays systematically heavier. */
  | { kind: "weekend"; weekday: number; weekendExtra: number };

export function intakeOnDay(shape: IntakeShape, dayIndex: number): number {
  switch (shape.kind) {
    case "constant":
      return shape.kcal;
    case "step":
      return dayIndex < shape.atDay ? shape.before : shape.after;
    case "weekend": {
      // Day 0 is a Monday in this synthetic calendar.
      const weekday = dayIndex % 7;
      return shape.weekday + (weekday >= 5 ? shape.weekendExtra : 0);
    }
  }
}

export type ScenarioSpec = {
  trueMaintenance: number;
  intake: IntakeShape;
  cadence: Cadence;
  /** Fraction of days with intake logged, 0-1. */
  coverage: number;
  startKg: number;
  /** Days *after* the burn-in. The measured window sits at the end of these. */
  days: number;
  /** kcal, day-to-day variation in what was actually eaten. */
  intakeNoiseKcal?: number;
  /** kg, day-to-day scale noise on top of the true weight. */
  scaleNoiseKg?: number;
  seed?: number;
};

export type Scenario = {
  trend: TrendPoint[];
  intake: IntakeIndex;
  asOf: string;
  /** Mean of the intake actually eaten over the measured window. */
  meanIntakeKcal: number;
  /**
   * Mean *logged* intake over the last `PREFERRED_WINDOW_DAYS`, which is the
   * figure `estimateTdee` actually averaged. The "on plan" projection has to be
   * given this rather than a whole-series mean, or the two projections are
   * being asked about different periods and disagree for a reason that has
   * nothing to do with the arithmetic under test.
   */
  windowMeanIntakeKcal: number;
  /** The true weight on `asOf`, before scale noise. */
  trueWeightKg: number;
  /** The true daily rate, kg/day, negative for loss. */
  trueKgPerDay: number;
  spec: ScenarioSpec;
};

const START = "2026-01-01";
const KCAL_PER_KG = 7700;

/**
 * Builds a series whose weight is the exact consequence of its intake.
 *
 * A **burn-in** runs before day zero so the EMA has reached steady state by the
 * time the measured window starts. That is the compensation for the trend lag:
 * during the transient the trend is still catching up to its seed, its slope is
 * shallower than the truth, and both projections inherit that error — which
 * would otherwise have to be absorbed by a tolerance loose enough to hide real
 * bugs. `trendBurnInDays()` derives the length from alpha rather than guessing.
 */
export function buildScenario(spec: ScenarioSpec): Scenario {
  const {
    trueMaintenance,
    cadence,
    coverage,
    startKg,
    days,
    intakeNoiseKcal = 0,
    scaleNoiseKg = 0,
    seed = 1,
  } = spec;

  const burnIn = trendBurnInDays(0.01);
  const total = burnIn + days;
  const random = mulberry32(seed);

  // 1.0 -> drop nothing; 0.9 -> drop every 10th; 0.8 -> drop every 5th.
  const skipEvery = coverage >= 1 ? 0 : Math.round(1 / (1 - coverage));

  const readings: { localDate: string; weightKg: number }[] = [];
  const intakeRows: { localDate: string; kcal: number }[] = [];

  let weightKg = startKg;
  let eatenInWindow = 0;
  let windowDays = 0;

  for (let i = 0; i < total; i++) {
    const localDate = addDays(START, i);
    const dayIndex = i - burnIn;

    // Intake for the day, plus day-to-day variation in what was eaten.
    const planned = intakeOnDay(spec.intake, Math.max(dayIndex, 0));
    const eaten = planned + (intakeNoiseKcal ? gaussian(random) * intakeNoiseKcal : 0);

    // Weight is the exact consequence of the energy balance.
    weightKg += (eaten - trueMaintenance) / KCAL_PER_KG;

    if (dayIndex >= 0) {
      eatenInWindow += eaten;
      windowDays += 1;
    }

    if (weighsIn(cadence, i, random)) {
      const observed = weightKg + (scaleNoiseKg ? gaussian(random) * scaleNoiseKg : 0);
      readings.push({ localDate, weightKg: observed });
    }

    // Coverage is applied deterministically — every k-th day dropped — not by
    // a coin flip. A random draw makes the realised coverage wander across the
    // 80% gate, so the cell meant to test the gate boundary silently falls back
    // to the formula instead and asserts nothing.
    const logged = dayIndex < 0 || skipEvery === 0 || dayIndex % skipEvery !== 0;
    if (logged) intakeRows.push({ localDate, kcal: Math.round(eaten) });
  }

  const asOf = addDays(START, total - 1);
  const intakeIndex = buildIntakeIndex({ manual: intakeRows });

  // The mean over exactly the window estimateTdee will use.
  const windowStart = addDays(asOf, -(PREFERRED_WINDOW_DAYS - 1));
  let windowSum = 0;
  let windowLogged = 0;
  for (const day of eachDay(windowStart, asOf)) {
    const value = intakeOn(intakeIndex, day);
    if (value === null) continue;
    windowSum += value;
    windowLogged += 1;
  }

  return {
    trend: computeTrend(readings, { to: asOf }),
    intake: intakeIndex,
    asOf,
    meanIntakeKcal: eatenInWindow / Math.max(windowDays, 1),
    windowMeanIntakeKcal: windowSum / Math.max(windowLogged, 1),
    trueWeightKg: weightKg,
    trueKgPerDay:
      (intakeOnDay(spec.intake, days - 1) - trueMaintenance) / KCAL_PER_KG,
    spec,
  };
}
