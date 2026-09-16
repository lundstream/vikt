import { describe, expect, it } from "vitest";
import { computeTrend } from "shared";
import { FORTNIGHT, HERO } from "../src/landing/fixture.generated.js";
import { fortnightGeometry, heroGeometry, type Geometry } from "../src/landing/seeded.js";

/**
 * The landing page's lines are the app's own arithmetic (D177).
 *
 * The hero used to be a cubic with four control points, chosen because it looked
 * like a trend. A page whose argument is "this app draws the trend rather than
 * the noise" cannot illustrate it with a shape somebody sketched, and nothing
 * would have caught it if §4.1 changed underneath the page.
 *
 * So the fixture carries **dated readings**, the trend through them is computed
 * by `packages/shared`'s EMA at build time (`scripts/landing-fixture.mjs`), and
 * this recomputes it here: every vertex the page draws has to equal the calc's
 * value for that date. It is the shape of the app's own chart test, pointed at
 * the marketing page.
 */

const SERIES = [
  { name: "the hero", fixture: HERO, geometry: heroGeometry() },
  { name: "the fortnight", fixture: FORTNIGHT, geometry: fortnightGeometry() },
] as const;

describe("every trend vertex is what the calc says for that date", () => {
  for (const series of SERIES) {
    it(`${series.name}`, () => {
      const computed = new Map(
        computeTrend(
          series.fixture.readings.map((reading) => ({
            localDate: reading.localDate,
            weightKg: reading.weightKg,
          })),
        ).map((point) => [point.localDate, point.trend]),
      );

      expect(series.geometry.vertices.length).toBe(series.fixture.readings.length);

      for (const vertex of series.geometry.vertices) {
        const expected = computed.get(vertex.localDate);
        expect(expected, `${vertex.localDate} is not in the computed trend`).toBeDefined();
        // The generated file rounds to three decimals, which is far finer than
        // the tenth of a kilo anybody reads.
        expect(
          Math.abs(vertex.trendKg - expected!),
          `${series.name} at ${vertex.localDate}: drawn ${vertex.trendKg}, calc ${expected}`,
        ).toBeLessThan(0.001);
      }
    });
  }

  /**
   * And the drawn path is those vertices, in order: a path that had been
   * smoothed, resampled or hand-adjusted would pass the check above and still
   * not be the trend.
   */
  for (const series of SERIES) {
    it(`${series.name}: the path is the vertices and nothing else`, () => {
      const drawn = [...series.geometry.path.matchAll(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map(
        (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
      );

      expect(drawn).toEqual(
        series.geometry.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
      );
      // No curve commands: straight segments between computed points.
      expect(series.geometry.path).not.toMatch(/[CSQTA]/);
    });
  }

  /** A guard against the fixture being regenerated into something silly. */
  it("draws a plausible body", () => {
    const weights = HERO.readings.map((r) => r.weightKg);
    expect(Math.min(...weights)).toBeGreaterThan(60);
    expect(Math.max(...weights)).toBeLessThan(140);

    /*
      The fortnight's scatter is what a daily swing actually looks like: about
      0,8 kg either side of the trend. It was 1,7, which draws a cloud nobody
      recognises from their own bathroom scale.
    */
    const trend = new Map(FORTNIGHT.trend.map((t) => [t.localDate, t.trendKg]));
    const spread = FORTNIGHT.readings.map((r) => Math.abs(r.weightKg - trend.get(r.localDate)!));
    expect(Math.max(...spread)).toBeLessThan(0.85);
  });
});

describe("the geometry", () => {
  const inBox = (geometry: Geometry, box: { width: number; height: number }) =>
    [...geometry.points, ...geometry.vertices].every(
      (point) => point.x >= 0 && point.x <= box.width && point.y >= 0 && point.y <= box.height,
    );

  it("stays inside its own viewBox", () => {
    expect(inBox(heroGeometry(), { width: 320, height: 150 })).toBe(true);
    expect(inBox(fortnightGeometry(), { width: 320, height: 150 })).toBe(true);
  });

  it("puts a reading on the page for every reading in the fixture", () => {
    expect(heroGeometry().points).toHaveLength(HERO.readings.length);
    expect(fortnightGeometry().points).toHaveLength(FORTNIGHT.readings.length);
  });
});
