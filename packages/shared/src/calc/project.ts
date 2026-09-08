import { addDays } from "./trend.js";
import { KCAL_PER_KG } from "./tdee.js";

/**
 * Projections — CLAUDE.md §4.3.
 *
 * Two numbers, always shown side by side, **never blended into one**: what the
 * plan implies, and what the last four weeks actually did. They disagree, and
 * the disagreement is the useful part.
 *
 * Nothing here hardcodes weight. `projectAtCurrentPace` takes a series and a
 * target, so phase 5's milestones — a waist measurement, a streak count —
 * regress their own series through the same function rather than a copy of it.
 *
 * Pure, and `asOf` is passed in.
 */

/** The 28 days §4.3 asks the pace fit to use. */
export const PACE_WINDOW_DAYS = 28;

/**
 * Beyond this, "at current pace" is arithmetic rather than information. A
 * projection two years out is not a date, it is a rounding error with a
 * calendar attached, and showing it as one is the kind of fabricated precision
 * this app is supposed to avoid.
 */
export const MAX_PROJECTION_DAYS = 730;

/**
 * Movement smaller than this per day counts as flat. 0.002 kg/day is about
 * 14 g a week — below the resolution of a bathroom scale smoothed over a month.
 */
export const FLAT_SLOPE_EPSILON = 0.002;

/**
 * Rounding slack before the day count is ceiled.
 *
 * A least-squares slope over a series built by repeated addition comes back as
 * -0.049999999999999996 rather than -0.05, so an exact 73-day answer lands at
 * 73.00000000000001 and `Math.ceil` reports 74. A day of difference from noise
 * twelve decimal places down is not a day.
 */
const CEIL_TOLERANCE = 1e-9;

/** Whole days, never nudged upwards by floating-point dust. */
function daysCeil(value: number): number {
  return Math.max(0, Math.ceil(value - CEIL_TOLERANCE));
}

export type Projection = {
  /** Whole days, always finite and >= 0. */
  daysToGoal: number;
  /** `YYYY-MM-DD`. */
  targetDate: string;
  /** True when the target is already met, in which case `daysToGoal` is 0. */
  alreadyThere: boolean;
};

export type SeriesPoint = {
  localDate: string;
  value: number;
};

/**
 * "On plan": what the planned deficit implies.
 *
 *   daysToGoal = (current - target) * 7700 / (tdee - targetIntake)
 *
 * Null when there is no usable deficit — no TDEE at all (D20), a target at or
 * above maintenance, or a horizon past {@link MAX_PROJECTION_DAYS}. Never a
 * negative or infinite date.
 */
export function projectOnPlan(input: {
  currentKg: number;
  goalKg: number;
  tdee: number | null;
  targetIntakeKcal: number;
  asOf: string;
}): Projection | null {
  const { currentKg, goalKg, tdee, targetIntakeKcal, asOf } = input;

  if (tdee === null || !Number.isFinite(tdee)) return null;
  if (!Number.isFinite(currentKg) || !Number.isFinite(goalKg)) return null;

  const remainingKg = currentKg - goalKg;
  if (remainingKg <= 0) return { daysToGoal: 0, targetDate: asOf, alreadyThere: true };

  const dailyDeficit = tdee - targetIntakeKcal;
  // Eating at or above maintenance never reaches a lower goal. Saying so beats
  // reporting a negative number of days.
  if (dailyDeficit <= 0) return null;

  const daysToGoal = daysCeil((remainingKg * KCAL_PER_KG) / dailyDeficit);
  if (!Number.isFinite(daysToGoal) || daysToGoal > MAX_PROJECTION_DAYS) return null;

  return { daysToGoal, targetDate: addDays(asOf, daysToGoal), alreadyThere: false };
}

/**
 * "At current pace": a least-squares line through the last
 * {@link PACE_WINDOW_DAYS} of the series, extrapolated to the target.
 *
 * Works in either direction. The fit has to be moving *towards* the target, so
 * a weight target below the current value needs a falling line and a streak
 * target above it needs a rising one. Flat, or moving away, returns null and
 * the UI says "not enough movement yet to project" — §4.3 is explicit that this
 * must never come back as a negative or infinite date.
 */
export function projectAtCurrentPace(input: {
  series: readonly SeriesPoint[];
  target: number;
  asOf: string;
  windowDays?: number;
}): Projection | null {
  const windowDays = input.windowDays ?? PACE_WINDOW_DAYS;

  const window = input.series
    .filter((point) => point.localDate <= input.asOf && Number.isFinite(point.value))
    .slice(-windowDays);

  // Two points is the minimum for a line, but two points is not a trend. A
  // week is the least that says anything about direction.
  if (window.length < 7) return null;

  const fit = leastSquares(window);
  if (fit === null) return null;

  const current = window[window.length - 1]!.value;
  const needed = input.target - current;

  if (Math.abs(needed) < 1e-9) {
    return { daysToGoal: 0, targetDate: input.asOf, alreadyThere: true };
  }

  // Flat counts as no movement, in either direction.
  if (Math.abs(fit.slopePerDay) < FLAT_SLOPE_EPSILON) return null;

  // Moving away from the target, or the wrong way entirely.
  if (Math.sign(fit.slopePerDay) !== Math.sign(needed)) return null;

  const daysToGoal = daysCeil(needed / fit.slopePerDay);
  if (!Number.isFinite(daysToGoal) || daysToGoal < 0) return null;
  if (daysToGoal > MAX_PROJECTION_DAYS) return null;

  return {
    daysToGoal,
    targetDate: addDays(input.asOf, daysToGoal),
    alreadyThere: false,
  };
}

export type LineFit = {
  /** Units of the series per day. Negative when the series is falling. */
  slopePerDay: number;
  /** Value the fit predicts on the first day of the window. */
  intercept: number;
};

/**
 * Ordinary least squares against days elapsed from the first point.
 *
 * Days elapsed rather than the index, so a series with gaps is not silently
 * compressed — though a trend series has one point per day by construction, and
 * this function is also handed raw measurement series by phase 4.
 */
export function leastSquares(points: readonly SeriesPoint[]): LineFit | null {
  if (points.length < 2) return null;

  const origin = Date.parse(`${points[0]!.localDate}T00:00:00Z`);
  if (Number.isNaN(origin)) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const point of points) {
    const time = Date.parse(`${point.localDate}T00:00:00Z`);
    if (Number.isNaN(time)) continue;
    xs.push((time - origin) / 86_400_000);
    ys.push(point.value);
  }
  if (xs.length < 2) return null;

  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    covariance += dx * (ys[i]! - meanY);
    variance += dx * dx;
  }

  // Every point on the same day: a vertical line has no slope to report.
  if (variance === 0) return null;

  const slopePerDay = covariance / variance;
  return { slopePerDay, intercept: meanY - slopePerDay * meanX };
}

/** Both projections together, for the side-by-side presentation §4.3 requires. */
export type ProjectionPair = {
  onPlan: Projection | null;
  atCurrentPace: Projection | null;
};

/* ------------------------------------------------- counted metrics (D79) */

/**
 * How a metric reaches its target: by being measured, or by being counted.
 *
 * The distinction is not cosmetic and it is not about units. A **measured**
 * metric — weight, waist, chest, the ratio between them — is a quantity the
 * body arrives at, sampled with noise, moving at a rate that has to be
 * estimated from the samples. Regression is the right tool and "not enough
 * movement yet" is a real answer, because sometimes there genuinely is none.
 *
 * A **counted** metric is not measured at all. `sober_days` and
 * `log_streak_days` advance by exactly one per day, by definition. Fitting a
 * line to them and reporting that the series "moves too little for a date" is
 * the app declining to do arithmetic it can do exactly: at day 28 of 100 the
 * answer is 72 days, and there is no uncertainty in it worth modelling.
 *
 * That is what the regression was actually doing. A counter is a perfect
 * straight line of slope 1, so the fit succeeds — but only for the days the
 * series carries, and a milestone on a young streak has too few points to clear
 * the seven-day minimum, so it returned null and the screen said the series
 * hardly moves. About a metric that had moved by one, every single day, without
 * exception.
 */
export type MetricKind = "measured" | "counted";

/**
 * Days remaining on a counter, and the date it lands.
 *
 * Exact arithmetic: one per day, so the answer is the difference. Never null
 * while the count is below the target, because there is nothing to be unsure
 * about — the uncertainty in a streak is not in its rate, it is in whether it
 * continues, and that is a different statement which the UI makes separately
 * rather than smuggling into a missing date.
 */
export function projectCounted(input: {
  current: number;
  target: number;
  asOf: string;
}): Projection | null {
  const { current, target, asOf } = input;
  if (!Number.isFinite(current) || !Number.isFinite(target)) return null;

  if (current >= target) return { daysToGoal: 0, targetDate: asOf, alreadyThere: true };

  const daysToGoal = daysCeil(target - current);

  /**
   * Still capped. A hundred-year streak target is arithmetic rather than
   * information, exactly as it is for a weight projection, and the cap is the
   * same one for the same reason.
   */
  if (daysToGoal > MAX_PROJECTION_DAYS) return null;

  return { daysToGoal, targetDate: addDays(asOf, daysToGoal), alreadyThere: false };
}

/**
 * Which kind a milestone metric is.
 *
 * A function rather than a property on the metric list, so the two callers that
 * project — the dashboard's goal date and the milestone card — cannot disagree
 * about what `sober_days` is.
 */
export function metricKind(metric: string): MetricKind {
  return metric === "sober_days" || metric === "log_streak_days" ? "counted" : "measured";
}
