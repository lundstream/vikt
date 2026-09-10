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

/**
 * The y-domain holds the readings, and the reason it did not used to.
 *
 * This block asserted the opposite until 10 September: the domain was built
 * from the **trend alone**, so that a couple of wild readings could not squash
 * the line into the middle quarter of the plot. The reasoning was right about
 * the hero and wrong about the arithmetic.
 *
 * The trend is an exponential moving average, so it lags. On a real series it
 * runs *through* the readings that produce it, and the most recent reading —
 * the one somebody opens the app to see — is the one furthest from it. A
 * morning weigh-in of 106,9 against a trend still at 108,4 fell outside a
 * trend-only domain and was clipped: invisible rather than wrong, which is
 * exactly why it survived a design pass. The chart looked fine and the missing
 * point looked like a day nobody logged.
 *
 * The fixture below also changed, because the old one was not a weight series.
 * It swung ±6 kg on consecutive days against a calm trend, which no body does:
 * real daily noise is salt, hydration and glycogen, and it is about ±1 kg. A
 * fixture built to justify clipping was proving that clipping worked.
 *
 * **What this costs.** A mistyped reading — 150 for 105 — now stretches the
 * axis instead of being hidden. That is the better failure: the point is
 * visible, and D56 put edit and delete on the row that shows it. A chart that
 * quietly omits a value is a chart that cannot be corrected from.
 */
describe("the y-domain holds every reading", () => {
  /** A real fortnight: a trend easing down, readings scattered ±1 kg around it. */
  const points: TrendPoint[] = [
    point("2026-01-01", 90.0, 90.6),
    point("2026-01-02", 89.8, 88.9),
    point("2026-01-03", 89.6, 90.3),
    point("2026-01-04", 89.4, 88.5),
    point("2026-01-05", 89.2, 88.3),
  ];

  it("contains every raw reading, padded", () => {
    const [min, max] = yDomain(points);
    for (const p of points) {
      expect(p.raw!, `${p.raw} outside [${min}, ${max}]`).toBeGreaterThanOrEqual(min);
      expect(p.raw!).toBeLessThanOrEqual(max);
    }
    expect(min).toBeLessThan(88.3);
    expect(max).toBeGreaterThan(90.6);
  });

  it("leaves the trend a readable share of the plot", () => {
    const [min, max] = yDomain(points);
    const trendSpan = 90.0 - 89.2;
    expect(trendSpan / (max - min)).toBeGreaterThan(0.15);
  });

  /**
   * The padding is proportional to the **trend's** spread rather than the
   * combined one, so a noisy morning widens the domain by its own distance and
   * not by a quarter of itself again.
   */
  it("does not compound the padding on a noisy series", () => {
    const [min, max] = yDomain(points);
    expect(max - min).toBeLessThan(4);
  });

  it("still gives a flat series a band to sit in", () => {
    const flat = ["2026-01-01", "2026-01-02", "2026-01-03"].map((d) => point(d, 90));
    const [min, max] = yDomain(flat);
    // 0.3 of padding either side of a flat line, floating point included.
    expect(max - min).toBeGreaterThan(0.55);
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
  /**
   * Both land on whole kilos now, and that is the counting change rather than
   * the cap. Choosing by an *estimate* of how many marks a step would place,
   * `floor(range / step) + 1`, assumed the first mark sat on the domain
   * minimum; it does not, so the estimate ran one high and a 6 kg window was
   * handed two-kilo steps. Counting the marks that actually land gives six at
   * 1 kg, which is inside the four-to-six band and finer.
   */
  it("uses whole kilos on a six-kilo window, capped or not", () => {
    expect(step(yTicks([85.5, 91.5], 6))).toBe(1);
    expect(step(yTicks([85.5, 91.5], 6, 1))).toBe(1);
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
