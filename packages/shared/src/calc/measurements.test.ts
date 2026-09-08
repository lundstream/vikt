import { describe, expect, it } from "vitest";
import {
  computeMeasurementSeries,
  MEASUREMENT_RANGE_CM,
  MEASUREMENT_SITES,
  sitesWithHistory,
  smoothedChange,
} from "./measurements.js";
import { computeSeriesTrend, TREND_ALPHA } from "./trend.js";

const readings = [
  { localDate: "2026-01-01", waist: 96, chest: 104 },
  { localDate: "2026-01-08", waist: 95.5, chest: 103.5 },
  { localDate: "2026-01-15", waist: 95, chest: null },
  { localDate: "2026-01-22", waist: 94, chest: 103 },
];

describe("measurement series", () => {
  /** D32: one smoother, called — not a second one written next to it. */
  it("is the §4.1 smoother, not a reimplementation", () => {
    const site = computeMeasurementSeries(readings, "waist");
    const direct = computeSeriesTrend([
      { localDate: "2026-01-01", value: 96 },
      { localDate: "2026-01-08", value: 95.5 },
      { localDate: "2026-01-15", value: 95 },
      { localDate: "2026-01-22", value: 94 },
    ]);

    expect(site).toEqual(direct);
  });

  it("uses the same per-day alpha as weight, so both lines lag equally", () => {
    const site = computeMeasurementSeries(readings, "waist");
    const second = site.find((point) => point.localDate === "2026-01-08")!;

    // gap of 7 days: effectiveAlpha = 1 - 0.9^7
    const expected = 96 + (1 - Math.pow(1 - TREND_ALPHA, 7)) * (95.5 - 96);
    expect(second.trend).toBeCloseTo(expected, 10);
  });

  it("skips days a site was not measured without breaking the series", () => {
    const chest = computeMeasurementSeries(readings, "chest");
    const skipped = chest.find((point) => point.localDate === "2026-01-15")!;

    expect(skipped.raw).toBeNull();
    expect(skipped.interpolated).toBe(true);
  });

  it("keeps the raw points, so the chart can draw them behind the line", () => {
    const waist = computeMeasurementSeries(readings, "waist");
    expect(waist.filter((point) => point.raw !== null).map((point) => point.raw)).toEqual([
      96, 95.5, 95, 94,
    ]);
  });

  it("is empty for a site with no readings at all", () => {
    expect(computeMeasurementSeries(readings, "thigh")).toEqual([]);
  });
});

describe("sitesWithHistory", () => {
  it("offers only the sites that have been measured", () => {
    expect(sitesWithHistory(readings)).toEqual(["waist", "chest"]);
  });

  it("is empty with no readings", () => {
    expect(sitesWithHistory([])).toEqual([]);
  });
});

describe("smoothedChange", () => {
  /**
   * The reason this exists rather than subtracting two raw readings: two tape
   * measurements 30 days apart differ by the real change *plus* up to 2 cm of
   * error, and quoting that difference states a number that is mostly noise.
   */
  it("subtracts smoothed values, not raw ones", () => {
    const series = computeMeasurementSeries(
      [...readings, { localDate: "2026-01-23", waist: 97.5 }],
      "waist",
    );
    const change = smoothedChange(series, 21)!;

    // The last raw reading is 1.5 cm *above* the first; the smoothed line is not.
    expect(change.deltaCm).toBeLessThan(0);
  });

  it("names the days it measured across", () => {
    const series = computeMeasurementSeries(readings, "waist");
    const change = smoothedChange(series, 21)!;

    expect(change.fromDate).toBe("2026-01-01");
    expect(change.toDate).toBe("2026-01-22");
  });

  it("clamps to the start of a series shorter than the window", () => {
    const series = computeMeasurementSeries(readings, "waist");
    expect(smoothedChange(series, 9999)!.fromDate).toBe("2026-01-01");
  });

  it("has nothing to report from a single day", () => {
    const series = computeMeasurementSeries(
      [{ localDate: "2026-01-01", waist: 96 }],
      "waist",
    );
    expect(smoothedChange(series, 30)).toBeNull();
  });
});

describe("the refusal bands", () => {
  it("covers every site", () => {
    for (const site of MEASUREMENT_SITES) {
      expect(MEASUREMENT_RANGE_CM[site].min).toBeLessThan(MEASUREMENT_RANGE_CM[site].max);
    }
  });

  it("is wide enough to reject typos rather than people", () => {
    // A slipped decimal point and a transposition, on either side.
    expect(MEASUREMENT_RANGE_CM.waist.max).toBeLessThan(400);
    expect(MEASUREMENT_RANGE_CM.waist.min).toBeLessThan(60);
  });
});
