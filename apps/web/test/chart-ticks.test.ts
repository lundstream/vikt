import { describe, expect, it } from "vitest";
import { formatDecimal } from "shared";
import { candidateSteps, niceTicks } from "../src/lib/ticks.js";
import { yDomain, yTicks } from "../src/components/TrendChart.js";
import type { TrendPoint } from "shared";

/**
 * The weight axis is a ruler, so its marks are evenly spaced *as printed*.
 *
 * Reported from the running app: the axis read
 *
 * ```
 * 109,0   108,8   108,5   108,3   108,0
 * ```
 *
 * Five correct values whose gaps are 0,2 / 0,3 / 0,2 / 0,3, because the step
 * was 0.25 kg and the labels carry one decimal. Every label was right and the
 * ruler was wrong, which is the worse failure: nothing about it looks like a
 * defect, and a reader measuring the distance between marks is being told two
 * different things alternately.
 *
 * The same report carried a second one: the latest reading, 106,9, did not
 * appear in the plot at all. The domain was built from the trend alone, the
 * trend lags the readings that produce it, and a point outside the domain is
 * clipped rather than clamped — invisible rather than wrong, which is why it
 * survived.
 */

const format = (value: number) => formatDecimal(value, { decimals: 1, grouping: false });

/** The gaps between consecutive labels, read off the rendered strings. */
function printedGaps(ticks: number[]): number[] {
  const printed = ticks.map((t) => Number(format(t).replace(",", ".")));
  return printed.slice(1).map((value, i) => Math.round((value - printed[i]!) * 100) / 100);
}

/**
 * The series behind the screenshot: a trend easing from 109,2 to 108,4 with
 * daily readings around it, and a last reading of 106,9 well below the line.
 */
function reportedSeries(): TrendPoint[] {
  const raws = [
    109.4, 109.0, 109.3, 108.8, 109.1, 108.6, 108.9, 108.4, 108.7, 108.2,
    108.5, 108.1, 108.4, 107.9, 108.2, 107.8, 108.0, 107.6, 107.9, 106.9,
  ];
  let trend = 109.2;
  return raws.map((raw, i) => {
    trend = trend + 0.1 * (raw - trend);
    return {
      localDate: `2026-08-${String(i + 1).padStart(2, "0")}`,
      raw,
      trend: Math.round(trend * 100) / 100,
      interpolated: false,
    };
  });
}

describe("the weight axis", () => {
  /** The defect, on the series it was reported from. */
  it("steps evenly at the precision it prints", () => {
    const domain = yDomain(reportedSeries());
    const ticks = yTicks(domain, 6, 1);

    const gaps = printedGaps(ticks);
    expect(new Set(gaps).size, `uneven gaps: ${gaps.join(", ")}`).toBe(1);

    // And the step is one of the ones a reader of a kilo scale expects.
    expect([0.2, 0.5, 1]).toContain(gaps[0]);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(6);
  });

  /**
   * The reading that was not drawn. 106,9 is below every trend value in the
   * series, so a trend-only domain excluded it.
   */
  it("holds every raw reading in the window", () => {
    const points = reportedSeries();
    const [low, high] = yDomain(points);

    for (const point of points) {
      if (point.raw === null) continue;
      expect(point.raw, `${point.raw} is outside [${low}, ${high}]`).toBeGreaterThanOrEqual(low);
      expect(point.raw).toBeLessThanOrEqual(high);
    }

    // Padded, so nothing sits exactly on the frame.
    expect(low).toBeLessThan(106.9);
    expect(high).toBeGreaterThan(Math.max(...points.map((p) => p.raw!)));
  });

  /** And the line still has room: it is not squashed into a sliver. */
  it("leaves the trend readable", () => {
    const points = reportedSeries();
    const [low, high] = yDomain(points);
    const trends = points.map((p) => p.trend);
    const share = (Math.max(...trends) - Math.min(...trends)) / (high - low);

    expect(share, "the trend occupies too little of the plot").toBeGreaterThan(0.15);
  });

  /**
   * The rule in general, not only on one series. Any window a real account
   * produces gets a step that is a whole number of tenths.
   */
  it("never offers a step that is not a whole number of tenths", () => {
    for (let range = 0.3; range <= 12; range += 0.1) {
      for (const step of candidateSteps(range, 1, 0.1)) {
        const tenths = step / 0.1;
        expect(
          Math.abs(tenths - Math.round(tenths)),
          `range ${range.toFixed(1)} offered step ${step}`,
        ).toBeLessThan(1e-6);
      }
    }
  });

  /**
   * And the marks a real window gets are evenly spaced, whatever the window.
   * The band is a preference; even spacing is not.
   */
  it("prints evenly at every window a real account produces", () => {
    for (let range = 0.4; range <= 12; range += 0.1) {
      const ticks = niceTicks(100, 100 + range, 6, format, 1, 0.1);
      if (ticks.length < 2) continue;
      const gaps = printedGaps(ticks);
      expect(new Set(gaps).size, `range ${range.toFixed(1)}: gaps ${gaps.join(", ")}`).toBe(1);
    }
  });

  /** 0.25 is what it used to pick, and is the thing being excluded. */
  it("is what this rule is actually looking for", () => {
    // 0.25 is the step that produced the reported axis, and a 1,2 kg window is
    // where the old progression reached for it. Without the quantum it is still
    // on offer; with it, it is not.
    expect(candidateSteps(1.2, 1)).toContainEqual(0.25);
    expect(candidateSteps(1.2, 1, 0.1)).not.toContainEqual(0.25);

    // And 2.5 survives, because at one decimal it is exact: 108,0 / 110,5 /
    // 113,0. The rule is about what prints evenly, not about round numbers.
    expect(candidateSteps(11, undefined, 0.1)).toContainEqual(2.5);
  });

  /** The guarantee that already existed, kept. */
  it("still renders no label twice", () => {
    for (let range = 0.2; range <= 20; range += 0.1) {
      const ticks = niceTicks(100, 100 + range, 6, format, 1, 0.1);
      const labels = ticks.map(format);
      expect(new Set(labels).size, `duplicate label at range ${range.toFixed(1)}`).toBe(
        labels.length,
      );
    }
  });
});
