/**
 * Waist-to-height — CLAUDE.md §4.4.
 *
 *     whtr = waistCm / heightCm
 *
 * Plotted on the same time axis as trend weight, because it frequently keeps
 * moving when the scale stalls. That is the entire point of showing it: a week
 * where the trend line is flat and the waist ratio is still falling is a week
 * that went fine, and without this series it reads as a week that went nowhere.
 *
 * The waist series is **smoothed through §4.1 before the ratio is taken** (D32).
 * A tape measure held by hand carries roughly ±1 cm on the waist, which is more
 * than a month of real change at any sane rate — so a raw waist chart is mostly
 * a picture of how tightly the tape was pulled. Height is a constant, so
 * smoothing the waist and then dividing is the same operation as smoothing the
 * ratio, and doing it on the waist means one number is smoothed once.
 *
 * Pure. No I/O, no clock.
 */
import { computeSeriesTrend, type TrendOptions, type TrendPoint } from "./trend.js";

/**
 * The common rule of thumb: keep your waist under half your height. It is a
 * population guideline, not a diagnosis, and the UI labels it as one — it is
 * drawn as a single reference line, with no bands, colours or verdicts around
 * it. Above all it is never used in a calculation.
 */
export const WHTR_RULE_OF_THUMB = 0.5;

/** The ratio, or null when either input is missing or not usable. */
export function whtr(waistCm: number | null, heightCm: number | null): number | null {
  if (waistCm === null || heightCm === null) return null;
  if (!Number.isFinite(waistCm) || !Number.isFinite(heightCm)) return null;
  if (waistCm <= 0 || heightCm <= 0) return null;
  return waistCm / heightCm;
}

export type WaistReading = {
  /** `YYYY-MM-DD`, computed by the client in its own timezone (CLAUDE.md §3). */
  localDate: string;
  waistCm: number;
};

export type WhtrPoint = {
  localDate: string;
  /** The measured ratio that day, or null when the waist was not measured. */
  raw: number | null;
  /** The ratio from the smoothed waist series. */
  whtr: number;
  interpolated: boolean;
};

/**
 * One point per day, aligned with `computeTrend` so the two series share an
 * axis. Days without a measurement carry the previous smoothed value forward
 * and have `raw: null` — never an invented reading, same rule as §4.1.
 *
 * Returns an empty array when there is no waist history or no usable height,
 * which is what the chart's toggle checks before offering itself.
 */
export function computeWhtrSeries(
  readings: readonly WaistReading[],
  heightCm: number | null,
  options: TrendOptions = {},
): WhtrPoint[] {
  if (heightCm === null || !Number.isFinite(heightCm) || heightCm <= 0) return [];

  const smoothed: TrendPoint[] = computeSeriesTrend(
    readings.map((reading) => ({
      localDate: reading.localDate,
      value: reading.waistCm,
    })),
    options,
  );

  return smoothed.map((point) => ({
    localDate: point.localDate,
    raw: point.raw === null ? null : point.raw / heightCm,
    whtr: point.trend / heightCm,
    interpolated: point.interpolated,
  }));
}

/** The most recent smoothed ratio, or null for an empty series. */
export function latestWhtr(points: readonly WhtrPoint[]): number | null {
  return points.at(-1)?.whtr ?? null;
}
