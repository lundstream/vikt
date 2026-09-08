import { describe, expect, it } from "vitest";
import type { TrendPoint } from "shared";
import { formatKg } from "shared";
import { yDomain, yTicks } from "../src/components/TrendChart.js";

/**
 * The y-axis rendered "108" twice — once as the lowest gridline and once as the
 * domain bound — because two different values rounded to the same label at one
 * decimal place. And the trend line occupied about a quarter of the plot height
 * because a couple of outlying raw readings were setting the bounds.
 *
 * Both are properties of the tick and domain functions, so both are pinned here
 * rather than left to be noticed again.
 */

function point(localDate: string, trend: number, raw: number | null = trend): TrendPoint {
  return { localDate, trend, raw, interpolated: raw === null };
}

const labels = (ticks: number[]) => ticks.map((tick) => tick.toFixed(1));

describe("y-axis ticks", () => {
  it("never repeats a label at the precision it renders", () => {
    for (const [min, max] of [
      [108, 108.4],
      [80, 80.05],
      [99.95, 100.05],
      [82.4, 82.400001],
      [0, 0.2],
    ] as const) {
      const rendered = labels(yTicks([min, max]));
      expect(new Set(rendered).size, `${min}..${max}`).toBe(rendered.length);
    }
  });

  it("still gives a full set of ticks over a normal range", () => {
    const ticks = yTicks([85, 95]);
    expect(ticks.length).toBe(5);
    expect(new Set(labels(ticks)).size).toBe(5);
  });

  it("keeps ticks inside the domain and in ascending order", () => {
    const domain: [number, number] = [86.2, 93.8];
    const ticks = yTicks(domain);
    expect(ticks[0]).toBeGreaterThanOrEqual(domain[0] - 0.05);
    expect(ticks.at(-1)!).toBeLessThanOrEqual(domain[1] + 0.05);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
  });

  it("collapses to one tick rather than five identical ones on a flat domain", () => {
    const ticks = yTicks([90, 90.01]);
    expect(new Set(labels(ticks)).size).toBe(ticks.length);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("returns nothing for an inverted or degenerate domain", () => {
    expect(yTicks([95, 85])).toEqual([]);
    expect(yTicks([90, 90])).toEqual([]);
    expect(yTicks([Number.NaN, 90])).toEqual([]);
  });
});

describe("the y-domain follows the trend, not the outliers", () => {
  /**
   * A calm trend with two wild readings. The trend is the hero (§5), so it has
   * to fill the plot; the outliers are allowed to sit at or beyond the edges.
   */
  const points: TrendPoint[] = [
    point("2026-01-01", 90.0, 90),
    point("2026-01-02", 89.8, 95.5), // a heavy meal and a late night
    point("2026-01-03", 89.6, 89),
    point("2026-01-04", 89.4, 84.0), // dehydrated
    point("2026-01-05", 89.2, 89),
  ];

  it("bounds the axis on the trend range plus padding", () => {
    const [min, max] = yDomain(points);
    // Trend spans 89.2..90.0. Padding is 25% of the spread, min 0.4.
    expect(min).toBeGreaterThan(88.0);
    expect(max).toBeLessThan(91.0);
  });

  it("gives the trend most of the plot height", () => {
    const [min, max] = yDomain(points);
    const trendSpan = 90.0 - 89.2;
    expect(trendSpan / (max - min)).toBeGreaterThan(0.4);
  });

  it("is not dragged out by the outlying readings", () => {
    const [min, max] = yDomain(points);
    // A raw-driven domain would have run 84..95.5 and squashed the line.
    expect(max - min).toBeLessThan(3);
  });

  it("still gives a flat series a band to sit in", () => {
    const flat = ["2026-01-01", "2026-01-02", "2026-01-03"].map((d) => point(d, 90));
    const [min, max] = yDomain(flat);
    expect(max - min).toBeGreaterThanOrEqual(0.8);
    expect(min).toBeLessThan(90);
    expect(max).toBeGreaterThan(90);
  });

  it("ignores days with no reading, which have a trend but no raw value", () => {
    const withGap = [
      point("2026-01-01", 90, 90),
      point("2026-01-02", 90, null),
      point("2026-01-03", 89.5, 89.5),
    ];
    const [min, max] = yDomain(withGap);
    expect(Number.isFinite(min)).toBe(true);
    expect(Number.isFinite(max)).toBe(true);
    expect(min).toBeLessThan(89.5);
    expect(max).toBeGreaterThan(90);
  });

  it("falls back to a usable domain for an empty series", () => {
    expect(yDomain([])).toEqual([0, 1]);
  });
});

/**
 * Round ticks, added after the design pass shipped `85,6 / 87,5 / 89,4 / 91,3 /
 * 93,2` on the hero element: evenly spaced, all correct, and all meaningless.
 */
describe("y ticks are round numbers", () => {
  it("marks the axis at halves and whole numbers", () => {
    // The exact domain that produced the broken axis.
    const ticks = yTicks([85.6, 93.2]);

    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const tick of ticks) {
      // Every tick is a multiple of the step, and the step is 1/2/2.5/5-ish,
      // so no tick has a stray second decimal.
      expect(Math.abs(tick * 2 - Math.round(tick * 2))).toBeLessThan(1e-9);
    }
  });

  it("stays inside the domain", () => {
    const ticks = yTicks([85.6, 93.2]);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(85.6);
      expect(tick).toBeLessThanOrEqual(93.2);
    }
  });

  it("gives half-kilo steps on a narrow window rather than three marks", () => {
    const ticks = yTicks([86.2, 88.4]);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
  });

  it("still never repeats a rendered label", () => {
    for (const domain of [
      [85.6, 93.2],
      [86.2, 88.4],
      [99.95, 100.05],
      [0.44, 0.52],
      [70, 130],
    ] as [number, number][]) {
      const labels = yTicks(domain).map((tick) => formatKg(tick));
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("is empty for a domain that is not a domain", () => {
    expect(yTicks([5, 5])).toEqual([]);
    expect(yTicks([Number.NaN, 5])).toEqual([]);
  });
});

/**
 * A kilo per mark, not two.
 *
 * The step is the smallest from the 1 / 2 / 2.5 / 5 progression that fits the
 * requested count, so a six-kilo window landed on 2 and the axis read
 * `86 / 88 / 90`. Half a kilo is a week of progress in this app, and an axis
 * that cannot show it is a ruler with the small marks filed off.
 */
describe("the one-kilo cap", () => {
  it("uses whole kilos where two-kilo steps would have fitted", () => {
    const uncapped = yTicks([85.5, 91.5], 6);
    const capped = yTicks([85.5, 91.5], 6, 1);

    expect(step(uncapped)).toBe(2);
    expect(step(capped)).toBe(1);
  });

  it("keeps half-kilo steps on a narrow window, since the cap is a ceiling", () => {
    expect(step(yTicks([86.2, 88.4], 6, 1))).toBe(0.5);
  });

  it("accepts more marks rather than breaking the cap", () => {
    // Ten kilos at one per mark is eleven marks, which is more than six.
    const ticks = yTicks([85, 95], 6, 1);
    expect(step(ticks)).toBe(1);
    expect(ticks.length).toBeGreaterThan(6);
  });

  it("still never repeats a rendered label under the cap", () => {
    for (const domain of [
      [85.6, 93.2],
      [86.2, 88.4],
      [99.95, 100.05],
    ] as [number, number][]) {
      const labels = yTicks(domain, 6, 1).map((tick) => formatKg(tick));
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("drops the cap on a wide domain, which is the caller's job", () => {
    // `TrendChart` only passes the cap below WIDE_DOMAIN_KG. Without it a
    // 40 kg history would be forty gridlines.
    expect(step(yTicks([70, 110], 6))).toBeGreaterThan(1);
  });
});

/** The gap between the first two marks, which is the step that was chosen. */
function step(ticks: number[]): number {
  return Math.round((ticks[1]! - ticks[0]!) * 1000) / 1000;
}
