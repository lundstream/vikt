/**
 * Trend weight — CLAUDE.md §4.1.
 *
 * Exponentially smoothed moving average, Hacker's Diet style, with alpha
 * measured **per day** rather than per reading:
 *
 *     alpha = 0.10                       // a 10-day smoothing constant, per day
 *     trend[0] = weight[0]               // seed on the first reading
 *     effectiveAlpha = 1 - (1 - alpha) ^ gap      // gap = days since the last reading
 *     trend[t] = trend[prev] + effectiveAlpha * (weight[t] - trend[prev])
 *
 * The gap term is not decoration. Applying a flat alpha only on days that have a
 * reading silently makes the smoothing constant depend on weighing frequency:
 * at weekly cadence a nominal 10-day constant behaves like roughly 70 days, and
 * the line never catches up. A real 2 kg loss over 16 days rendered as 0.29 kg.
 * Compounding alpha across the gap is the same EMA sampled irregularly, and with
 * daily readings `gap` is 1 and the formula reduces to the plain form — so a
 * daily series is bit-for-bit unchanged.
 *
 * On a day with no reading the trend carries forward unchanged and the point is
 * marked `interpolated`; only the *update* step is gap-aware. The **raw** series
 * is never interpolated: a day with no reading has `raw: null`, and the chart
 * draws a gap there rather than inventing a number.
 *
 * This is the primary number in the product (D2). Daily weight swings on water,
 * salt and gut contents; the smoothed line is what the user is actually asking
 * about, and the raw points sit behind it as evidence.
 *
 * Pure. No I/O, no clock — `to` must be passed in, so the same inputs always
 * produce the same output on the server and in the browser.
 */

/** Per **day**, not per reading. See the note above and CLAUDE.md §4.1. */
export const TREND_ALPHA = 0.1;

/**
 * The smoothing weight for a reading `gap` days after the previous one.
 * `gap = 1` returns `alpha` exactly, which is why daily series do not change.
 */
export function effectiveAlpha(gap: number, alpha: number = TREND_ALPHA): number {
  if (!Number.isFinite(gap) || gap <= 0) return alpha;
  return 1 - Math.pow(1 - alpha, gap);
}

/**
 * How many days the trend lags a steadily changing weight, at a given weigh-in
 * gap.
 *
 * Derivation. With `beta = (1 - alpha)^gap` the update is
 *
 *     trend[n] = beta * trend[n-1] + (1 - beta) * x[n]
 *
 * On a series changing by `m` per day, so `x[n] = x[n-1] + m*gap`, write the
 * shortfall `d[n] = x[n] - trend[n]`:
 *
 *     d[n] = x[n] - beta*trend[n-1] - (1-beta)*x[n]
 *          = beta * (x[n] - trend[n-1])
 *          = beta * (d[n-1] + m*gap)
 *
 * At steady state `d = beta*(d + m*gap)`, so `d = m * gap * beta / (1 - beta)`,
 * and dividing out the rate gives the lag in **days**:
 *
 *     lagDays = gap * (1 - alpha)^gap / (1 - (1 - alpha)^gap)
 *
 * At `gap = 1` this is `(1 - alpha) / alpha` = 9 days, the familiar figure.
 * Longer gaps lag *less*, not more — 6.4 days at a weekly cadence — because
 * each update jumps most of the way to the new reading. That is the opposite of
 * what the old per-reading alpha did, and it is worth knowing when reading a
 * chart: the line is not equally far behind for everybody.
 *
 * Used by the projection-convergence invariant to compensate for the transient
 * rather than absorb it into a loose tolerance.
 */
export function trendLagDays(gapDays: number, alpha: number = TREND_ALPHA): number {
  if (!Number.isFinite(gapDays) || gapDays <= 0) return 0;
  if (alpha <= 0 || alpha >= 1) return 0;

  const beta = Math.pow(1 - alpha, gapDays);
  if (beta >= 1) return Number.POSITIVE_INFINITY;
  return (gapDays * beta) / (1 - beta);
}

/**
 * Days of history needed for the seed's influence to fall below `residual`.
 *
 * `(1 - alpha)^days < residual`, so `days > ln(residual) / ln(1 - alpha)`. The
 * decay is per day and independent of cadence, which is what makes it a usable
 * burn-in for a test fixture at any weigh-in frequency.
 */
export function trendBurnInDays(residual = 0.01, alpha: number = TREND_ALPHA): number {
  if (alpha <= 0 || alpha >= 1 || residual <= 0 || residual >= 1) return 0;
  return Math.ceil(Math.log(residual) / Math.log(1 - alpha));
}

/**
 * A dated value, whatever it measures. `computeSeriesTrend` smooths these; the
 * weight-specific `computeTrend` below is a thin wrapper over it.
 */
export type DatedValue = {
  /** `YYYY-MM-DD`, computed by the client in its own timezone (CLAUDE.md §3). */
  localDate: string;
  value: number;
};

export type WeightReading = {
  /** `YYYY-MM-DD`, computed by the client in its own timezone (CLAUDE.md §3). */
  localDate: string;
  weightKg: number;
};

export type TrendPoint = {
  localDate: string;
  /** The reading for that day, or null when there was none. Never filled in. */
  raw: number | null;
  trend: number;
  /** True when there was no reading and the trend was carried forward. */
  interpolated: boolean;
};

export type TrendOptions = {
  /** Defaults to `TREND_ALPHA`. Exposed for tests and for nothing else. */
  alpha?: number;
  /**
   * Extend the series to this date, carrying the trend forward. Without it the
   * series ends at the last reading, so a week of not weighing in would make
   * the line stop rather than flatten.
   */
  to?: string;
  /** Start here instead of at the first reading. Earlier readings are ignored. */
  from?: string;
};

/**
 * One point per day from the first reading to the last (or to `to`), in
 * ascending date order.
 *
 * Duplicate readings for a day: the last one wins. The database has a unique
 * index on `(user_id, local_date)` so this should not arise from stored data,
 * but the function is also handed unsaved optimistic entries by the client.
 */
export function computeTrend(
  readings: readonly WeightReading[],
  options: TrendOptions = {},
): TrendPoint[] {
  return computeSeriesTrend(
    readings.map((reading) => ({ localDate: reading.localDate, value: reading.weightKg })),
    options,
  );
}

/**
 * The same smoothing, for any dated series.
 *
 * Phase 4 runs body measurements through this (D32). A hand-held tape measure
 * carries roughly ±1 cm of error on the waist, which is more than a month of
 * real change, so the raw series is at least as misleading there as it is on the
 * scale — and the answer is the one already built and tested here, not a second
 * one written next to it. `computeTrend` is now a wrapper over this function, so
 * there is exactly one implementation of §4.1 and a bug in it cannot be fixed
 * in one place and left in the other.
 */
export function computeSeriesTrend(
  readings: readonly DatedValue[],
  options: TrendOptions = {},
): TrendPoint[] {
  const alpha = options.alpha ?? TREND_ALPHA;

  const byDate = new Map<string, number>();
  for (const reading of readings) {
    if (!Number.isFinite(reading.value)) continue;
    byDate.set(reading.localDate, reading.value);
  }

  const dates = [...byDate.keys()].sort();
  const firstReading = dates[0];
  // No readings means no trend. An empty series is a legitimate answer, and the
  // UI shows an empty state rather than a flat line at zero.
  if (firstReading === undefined) return [];

  const start = options.from && options.from > firstReading ? options.from : firstReading;
  const lastReading = dates[dates.length - 1]!;
  const end = options.to && options.to > lastReading ? options.to : lastReading;
  if (end < start) return [];

  const points: TrendPoint[] = [];
  let trend: number | undefined;
  let daysSinceReading = 0;

  for (const localDate of eachDay(start, end)) {
    const raw = byDate.get(localDate) ?? null;
    daysSinceReading += 1;

    if (raw !== null) {
      if (trend === undefined) {
        // Seed on the first reading.
        trend = raw;
      } else {
        // Compound alpha across the gap, so the constant stays per-day.
        trend = trend + effectiveAlpha(daysSinceReading, alpha) * (raw - trend);
      }
      daysSinceReading = 0;
    }

    // Only possible when `from` skips past the first reading; there is nothing
    // to carry forward yet, so the point does not exist.
    if (trend === undefined) continue;

    points.push({
      localDate,
      raw,
      trend,
      interpolated: raw === null,
    });
  }

  return points;
}

/** The most recent trend value, or null for an empty series. */
export function latestTrend(points: readonly TrendPoint[]): number | null {
  return points.at(-1)?.trend ?? null;
}

/**
 * Inclusive `YYYY-MM-DD` iteration, done in UTC arithmetic on purpose.
 *
 * These strings are already local dates decided by the client. Parsing them at
 * UTC midnight and stepping by whole days keeps the arithmetic away from the
 * host's timezone and from daylight saving, either of which would otherwise
 * duplicate or skip a day twice a year.
 */
export function* eachDay(from: string, to: string): Generator<string> {
  const end = Date.parse(`${to}T00:00:00Z`);
  let cursor = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(cursor) || Number.isNaN(end)) return;

  while (cursor <= end) {
    yield new Date(cursor).toISOString().slice(0, 10);
    cursor += 86_400_000;
  }
}

/** `offset` days from `localDate`, as a `YYYY-MM-DD` string. */
export function addDays(localDate: string, offset: number): string {
  const base = Date.parse(`${localDate}T00:00:00Z`);
  if (Number.isNaN(base)) throw new TypeError(`not a date: ${localDate}`);
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}
