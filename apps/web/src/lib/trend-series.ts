import type { TrendPoint } from "shared";

/**
 * What the chart draws, as distinct from what §4.1 computes.
 *
 * The arithmetic in `packages/shared/src/calc/trend.ts` is right and is not
 * touched by anything here. It returns **one point per day**, and on a day with
 * no reading it carries the previous trend forward unchanged and marks the
 * point `interpolated` — which is the correct answer to "what is the trend on
 * the eleventh", and the wrong thing to hand a line chart.
 *
 * Handed to a line, a carried-forward value is a *vertex*: the line is told to
 * pass exactly through it. With daily readings that is invisible, because every
 * day is a real reading. With sparse ones it draws a **staircase** — flat
 * across the gap, then the whole move in a single day-wide step — and the
 * picture says the weight was steady for nine days and then fell a kilo
 * overnight. Nothing in the data says that. What the data says is that two
 * readings nine days apart produced two trend values, and the line between them
 * is an interpolation the chart is supposed to draw.
 *
 * So the chart gets a vertex on each **reading date** and nothing in between,
 * and Recharts' monotone curve joins them. Monotone rather than a natural
 * spline because it cannot overshoot: a cubic through a flat run and then a
 * drop will dip below the lower reading on its way, and a trend line that
 * briefly shows a weight nobody recorded is exactly the kind of invented number
 * §2 forbids everywhere else.
 *
 * The carried-forward days keep their row, because the x axis is categorical
 * over days. Dropping them would space readings evenly regardless of how far
 * apart they are, which is a worse lie than the staircase.
 */

/** A point the trend line actually passes through. */
export type TrendVertex = { localDate: string; trend: number };

/**
 * One vertex per reading date, with the value §4.1 computed for that date.
 *
 * The value is never recomputed here and never adjusted. This function
 * **selects**; if it ever starts to calculate, the chart and the maintenance
 * figure have begun to disagree about the same day.
 */
export function trendVertices(points: readonly TrendPoint[]): TrendVertex[] {
  return points
    .filter((point) => point.raw !== null)
    .map((point) => ({ localDate: point.localDate, trend: point.trend }));
}

/**
 * The same points, with the trend nulled on days that carried it forward.
 *
 * One row per day so the axis stays proportional to time, and `connectNulls` on
 * the line so the curve spans the gaps. The raw readings are untouched: they
 * were never interpolated and are still drawn where they were taken.
 */
export function withTrendVertices<T extends TrendPoint>(
  points: readonly T[],
): (Omit<T, "trend"> & { trend: number | null })[] {
  return points.map((point) => ({
    ...point,
    trend: point.raw === null ? null : point.trend,
  }));
}
