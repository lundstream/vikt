/**
 * Body measurements, smoothed the same way weight is (D32).
 *
 * A tape measure held by hand carries roughly ±1 cm on the waist — tension,
 * where exactly it sits, whether you breathed out. A month of steady loss moves
 * the waist about the same distance, so a raw measurement chart is close to
 * unreadable: real change and measurement error have the same amplitude, and
 * the eye cannot tell them apart.
 *
 * The answer is the one already built for weight, so this file **calls
 * `computeSeriesTrend` from §4.1** rather than smoothing anything itself. There
 * is one implementation of the EMA in this codebase; a fix to it must not be
 * possible in one place and missed in another. Everything here is bookkeeping
 * around that call.
 *
 * Pure. No I/O, no clock.
 */
import { computeSeriesTrend, type TrendOptions, type TrendPoint } from "./trend.js";

/**
 * The sites, in the order they are shown.
 *
 * Waist first because it is the one that matters and the one people actually
 * keep up with; the optional two last. The order is here rather than in the UI
 * so the form, the chart legend and the API agree without being kept in sync by
 * hand.
 */
export const MEASUREMENT_SITES = [
  "waist",
  "chest",
  "neck",
  "hips",
  "thigh",
  "arm",
] as const;

export type MeasurementSite = (typeof MEASUREMENT_SITES)[number];

/** Every site is optional — a partial measurement is a valid measurement. */
export type MeasurementReading = {
  /** `YYYY-MM-DD`, computed by the client in its own timezone (CLAUDE.md §3). */
  localDate: string;
} & Partial<Record<MeasurementSite, number | null>>;

/**
 * A refusal band per site, in cm. These reject typos, not people: a waist of
 * 400 is a slipped decimal point, a waist of 45 is a transposition. They are
 * deliberately wide.
 */
export const MEASUREMENT_RANGE_CM: Record<MeasurementSite, { min: number; max: number }> = {
  waist: { min: 40, max: 250 },
  chest: { min: 40, max: 250 },
  neck: { min: 20, max: 80 },
  hips: { min: 40, max: 250 },
  thigh: { min: 20, max: 120 },
  arm: { min: 10, max: 80 },
};

/**
 * The smoothed series for one site, plus the raw points to draw behind it.
 *
 * Identical shape to `TrendPoint`, because it is the same computation on a
 * different column, and the chart component should not need to know which.
 */
export function computeMeasurementSeries(
  readings: readonly MeasurementReading[],
  site: MeasurementSite,
  options: TrendOptions = {},
): TrendPoint[] {
  return computeSeriesTrend(
    readings
      .map((reading) => ({ localDate: reading.localDate, value: reading[site] }))
      .filter((point): point is { localDate: string; value: number } =>
        typeof point.value === "number",
      ),
    options,
  );
}

/** Which sites have at least one reading, so the UI offers only those series. */
export function sitesWithHistory(
  readings: readonly MeasurementReading[],
): MeasurementSite[] {
  return MEASUREMENT_SITES.filter((site) =>
    readings.some((reading) => typeof reading[site] === "number"),
  );
}

/**
 * Change in the **smoothed** series over the last `days`, in cm.
 *
 * Deliberately not a difference of two raw readings. Two measurements 30 days
 * apart differ by their real change plus up to 2 cm of tape error, and quoting
 * that difference as "you lost 1.5 cm" states a number that is mostly noise.
 * Returns null when the window does not contain enough of a series to subtract.
 */
export function smoothedChange(
  points: readonly TrendPoint[],
  days: number,
): { deltaCm: number; fromDate: string; toDate: string } | null {
  const last = points.at(-1);
  if (!last || points.length < 2) return null;

  const wanted = points.length - 1 - days;
  const first = points[wanted < 0 ? 0 : wanted]!;
  if (first.localDate === last.localDate) return null;

  return {
    deltaCm: last.trend - first.trend,
    fromDate: first.localDate,
    toDate: last.localDate,
  };
}
