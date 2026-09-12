import { describe, expect, it } from "vitest";
import { computeTrend } from "shared";
import { trendVertices, withTrendVertices } from "../src/lib/trend-series.js";

/**
 * What the chart is allowed to draw between two readings (D144).
 *
 * §4.1 returns one point per day and carries the trend forward on a day with no
 * reading. That is the right answer to "what is the trend on the eleventh" and
 * the wrong thing to hand a line, because a line treats every point as a vertex
 * it must pass through: flat across the gap, then the whole move in one
 * day-wide step. The picture said the weight held steady for nine days and then
 * fell a kilo overnight, which is not in the data.
 *
 * This file holds the one property that keeps the fix honest: **the chart shows
 * the calc's own numbers, selected, never recomputed**. A transform that
 * started smoothing or re-seeding on its own would make the line and the
 * maintenance figure disagree about the same day, and nothing else in the suite
 * would notice.
 */

/** A fortnight, weighed on three days. The shape that produced the staircase. */
const SPARSE = [
  { localDate: "2026-09-01", weightKg: 92.0 },
  { localDate: "2026-09-10", weightKg: 90.6 },
  { localDate: "2026-09-14", weightKg: 90.1 },
];

describe("the vertices the line passes through", () => {
  it("is one per reading, not one per day", () => {
    const points = computeTrend(SPARSE, { to: "2026-09-20" });
    // Twenty days of points, because the series runs to `to`.
    expect(points).toHaveLength(20);

    const vertices = trendVertices(points);
    expect(vertices).toHaveLength(SPARSE.length);
    expect(vertices.map((vertex) => vertex.localDate)).toEqual(
      SPARSE.map((reading) => reading.localDate),
    );
  });

  /**
   * The assertion that stops the rendering drifting from the maths. Each vertex
   * carries §4.1's value for that date, to the bit.
   */
  it("carries the calc's trend for that date, unchanged", () => {
    const points = computeTrend(SPARSE, { to: "2026-09-20" });
    const byDate = new Map(points.map((point) => [point.localDate, point.trend]));

    for (const vertex of trendVertices(points)) {
      expect(vertex.trend).toBe(byDate.get(vertex.localDate));
    }
  });

  /**
   * With a reading every day the two are the same thing, which is why this went
   * unnoticed for as long as it did: the owner weighs most mornings.
   */
  it("is every day when every day has a reading", () => {
    const daily = [
      { localDate: "2026-09-01", weightKg: 92.0 },
      { localDate: "2026-09-02", weightKg: 91.8 },
      { localDate: "2026-09-03", weightKg: 91.9 },
    ];
    const points = computeTrend(daily);

    expect(trendVertices(points)).toHaveLength(points.length);
  });

  it("has nothing to draw for a series with no readings", () => {
    expect(trendVertices([])).toEqual([]);
  });
});

describe("the rows the chart receives", () => {
  /**
   * One row per day even so. The x axis is categorical over these rows, so
   * dropping the gap days would space two readings a month apart the same as
   * two a day apart, which is a worse lie than the staircase was.
   */
  it("keeps a row for every day and a trend only on reading dates", () => {
    const points = computeTrend(SPARSE, { to: "2026-09-20" });
    const rows = withTrendVertices(points);

    expect(rows).toHaveLength(points.length);
    expect(rows.filter((row) => row.trend !== null)).toHaveLength(SPARSE.length);

    for (const row of rows) {
      if (row.raw === null) expect(row.trend).toBeNull();
      else expect(row.trend).toBe(points.find((p) => p.localDate === row.localDate)?.trend);
    }
  });

  /** The raw series was never interpolated and is not touched here either. */
  it("leaves the readings exactly where they were taken", () => {
    const rows = withTrendVertices(computeTrend(SPARSE, { to: "2026-09-20" }));
    const readings = rows.filter((row) => row.raw !== null);

    expect(readings.map((row) => [row.localDate, row.raw])).toEqual(
      SPARSE.map((reading) => [reading.localDate, reading.weightKg]),
    );
  });

  /**
   * The last day of a window is usually a day nobody weighed, because the
   * series runs to today. The line now ends at the last reading rather than
   * running flat to the right edge, which is the same honesty the raw dots
   * have always had.
   */
  it("ends the line at the last reading, not at the last day", () => {
    const rows = withTrendVertices(computeTrend(SPARSE, { to: "2026-09-20" }));

    expect(rows.at(-1)?.localDate).toBe("2026-09-20");
    expect(rows.at(-1)?.trend).toBeNull();
    expect(rows.findLast((row) => row.trend !== null)?.localDate).toBe("2026-09-14");
  });
});
