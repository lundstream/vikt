import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeTrend } from "shared";
import { FORTNIGHT, HERO } from "../src/landing/fixture.generated.js";
import {
  FORTNIGHT_SOURCE,
  HERO_SOURCE,
} from "../src/landing/fixture.source.generated.js";
import {
  heroGeometry,
  HERO_BOX,
  MORNINGS,
  SETTLED_TREND,
  SETTLED_TREND_DATE,
  type Geometry,
} from "../src/landing/seeded.js";

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
 *
 * ## What changed with the curve (D178)
 *
 * The path is a monotone cubic now, the same interpolation `TrendChart.tsx`
 * uses, so it is no longer a list of straight segments between the vertices.
 * The check is therefore on the **end points** of those cubics: every segment
 * has to land exactly on a computed vertex, in order, so the curve passes
 * through every value the calc produced and the control points only decide how
 * it travels between them.
 *
 * ## And with the warm-up
 *
 * Each series is longer than the picture, and the page draws the last `shown`
 * readings plus the one trend vertex before them. The comparison recomputes
 * over the **whole** series and looks up each drawn vertex by its own date,
 * which is also what proves the warm-up is real: the first drawn vertex is not
 * the first reading, because it was not seeded on it.
 *
 * ## The fortnight is a value now, not a line (D179)
 *
 * "En dagsvikt är mest brus" no longer draws a graph: it states the fourteen
 * readings as figures and the trend as one number. So its check is on that
 * number, recomputed the same way and formatted the way the page formats it.
 * It is a smaller claim than a line of vertices and it is the whole claim the
 * section makes.
 */

/**
 * Each series twice over: the window the page ships, and the whole series it was
 * computed from. The comparison is between them, which is what makes this a
 * check on the page rather than on the generator talking to itself.
 */
const SERIES = [
  { name: "the hero", fixture: HERO, source: HERO_SOURCE, geometry: heroGeometry() },
] as const;

/** §4.1 over a whole series, by date, which is what the page's figures claim. */
const trendByDate = (readings: readonly { localDate: string; weightKg: number }[]) =>
  new Map(
    computeTrend(
      readings.map((reading) => ({
        localDate: reading.localDate,
        weightKg: reading.weightKg,
      })),
    ).map((point) => [point.localDate, point.trend]),
  );

/** The end point of every command in a path, which is its last coordinate pair. */
function anchors(path: string): { x: number; y: number }[] {
  const command = /[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)|C(?:\s+-?[\d.]+){4}\s+(-?[\d.]+)\s+(-?[\d.]+)/g;
  return [...path.matchAll(command)].map((match) => ({
    x: Number(match[1] ?? match[3]),
    y: Number(match[2] ?? match[4]),
  }));
}

/** The four control coordinates of each cubic, in order. */
function cubics(path: string): number[][] {
  return path
    .split(" C ")
    .slice(1)
    .map((segment) => segment.trim().split(/\s+/).map(Number));
}

describe("every trend vertex is what the calc says for that date", () => {
  for (const series of SERIES) {
    it(`${series.name}`, () => {
      /*
        Recomputed over the **whole** series, warm-up included, which is the
        only way the drawn values can be checked at all: a trend computed over
        just the window would be a different line, seeded on the first reading
        the page happens to show.
      */
      const computed = new Map(
        computeTrend(
          series.source.readings.map((reading) => ({
            localDate: reading.localDate,
            weightKg: reading.weightKg,
          })),
        ).map((point) => [point.localDate, point.trend]),
      );

      /* One vertex per drawn reading, plus the one before the window. */
      expect(series.geometry.vertices.length).toBe(series.fixture.shown + 1);
      expect(series.geometry.points.length).toBe(series.fixture.shown);
      expect(series.fixture.readings.length).toBe(series.fixture.shown);

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
   * And the drawn curve passes through those vertices, in order: a path that
   * had been resampled or hand-adjusted would pass the check above and still
   * not be the trend.
   */
  for (const series of SERIES) {
    it(`${series.name}: the curve passes through every vertex`, () => {
      expect(anchors(series.geometry.path)).toEqual(
        series.geometry.vertices.map((vertex) => ({ x: vertex.x, y: vertex.y })),
      );
    });

    /**
     * Monotone, which is the property the app's chart chose it for: between two
     * readings the curve may not leave the interval they bound, so it never
     * draws a weight nobody recorded. Sampled along each cubic, because an
     * overshoot lives between the end points rather than at them.
     */
    it(`${series.name}: the curve never leaves the values it joins`, () => {
      const vertices = series.geometry.vertices;

      for (const [index, control] of cubics(series.geometry.path).entries()) {
        const from = vertices[index]!;
        const to = vertices[index + 1]!;
        const low = Math.min(from.y, to.y);
        const high = Math.max(from.y, to.y);

        for (let step = 1; step < 32; step += 1) {
          const t = step / 32;
          const u = 1 - t;
          const y =
            u * u * u * from.y +
            3 * u * u * t * control[1]! +
            3 * u * t * t * control[3]! +
            t * t * t * to.y;
          expect(
            y,
            `${series.name} overshoots between ${from.localDate} and ${to.localDate}`,
          ).toBeGreaterThanOrEqual(low - 0.01);
          expect(y).toBeLessThanOrEqual(high + 0.01);
        }
      }
    });
  }

  /** A guard against the fixture being regenerated into something silly. */
  it("draws a plausible body", () => {
    const weights = HERO.readings.map((r) => r.weightKg);
    expect(Math.min(...weights)).toBeGreaterThan(60);
    expect(Math.max(...weights)).toBeLessThan(140);
  });

  /**
   * Both series scatter by about 0,8 kg from the trend, which is what a day to
   * day swing actually looks like. The fortnight was once 1,7 and the hero
   * twice the fortnight, which between them said the noise gets smaller the
   * longer you look at it, and the page argues the opposite.
   */
  for (const series of SERIES) {
    it(`${series.name}: the readings scatter like a real scale`, () => {
      const trend = new Map(series.fixture.trend.map((t) => [t.localDate, t.trendKg]));
      const spread = series.fixture.readings.map((r) =>
        Math.abs(r.weightKg - trend.get(r.localDate)!),
      );
      expect(Math.max(...spread)).toBeLessThan(0.85);
    });
  }

  /**
   * The warm-up, asserted rather than described: the first drawn vertex must
   * **not** be the first reading of the series. §4.1 seeds on the first
   * reading, so a trend computed over only what is shown would start exactly on
   * a point, and the picture would open with an artefact of where it was
   * cropped rather than with the app's own line.
   */
  for (const series of SERIES) {
    it(`${series.name}: the line is warmed up before the picture starts`, () => {
      expect(series.source.readings.length).toBeGreaterThan(series.fixture.shown);

      const firstDrawn = series.geometry.vertices[0]!;
      const seeded = series.source.readings[0]!;
      expect(firstDrawn.localDate).not.toBe(seeded.localDate);
      expect(firstDrawn.trendKg).not.toBe(seeded.weightKg);

      /*
        And the drawn window really is the end of the series, rather than a
        second fixture that happens to look similar.
      */
      expect(series.fixture.readings.at(-1)!.localDate).toBe(
        series.source.readings.at(-1)!.localDate,
      );
      expect(series.fixture.readings[0]!.localDate).toBe(
        series.source.readings.at(-series.fixture.shown)!.localDate,
      );
    });
  }

  /**
   * Each reading knows where it sits along the line, which is what lets the
   * points and the line advance together instead of a cloud being crossed out
   * by a curve. The fractions have to run forward, start after the line has
   * entered, and reach the end.
   */
  for (const series of SERIES) {
    it(`${series.name}: every reading is placed along the line`, () => {
      const places = series.geometry.points.map((point) => point.at);

      expect(places.every((value) => value >= 0 && value <= 1)).toBe(true);
      expect([...places].sort((a, b) => a - b)).toEqual(places);
      // The first reading is one vertex in, and the last is the end of the line.
      expect(places[0]).toBeGreaterThan(0);
      expect(places.at(-1)).toBeCloseTo(1, 5);
    });
  }
});

describe("the geometry", () => {
  const inBox = (geometry: Geometry, box: { width: number; height: number }) =>
    [...geometry.points, ...geometry.vertices].every(
      (point) => point.x >= 0 && point.x <= box.width && point.y >= 0 && point.y <= box.height,
    );

  /* The box the component draws into, not a number copied into a test. */
  it("stays inside its own viewBox", () => {
    expect(inBox(heroGeometry(), HERO_BOX)).toBe(true);
  });

  /**
   * A dot per **drawn** reading. The rest of each series is the warm-up: it is
   * computed and never displayed, and a picture that showed all sixty would be
   * showing the thing the window exists to crop.
   */
  it("puts a reading on the page for every reading it draws", () => {
    expect(heroGeometry().points).toHaveLength(HERO.shown);
  });

  /**
   * The page never imports the warm-up. It is a hundred numbers that exist to
   * make the line right at build time, and the budget for everything `/` loads
   * is 60 kB, which the whole series had already taken to 59,6.
   */
  it("ships only the window it draws", () => {
    const src = path.join(import.meta.dirname, "../src");
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((entry) => /\.(ts|tsx)$/.test(entry))
      /*
        An import, not a mention: two comments point at the source file to
        explain why it exists, and a check that cannot tell those from an import
        is a check that fails for being right.
      */
      .filter((entry) =>
        /from\s+["'][^"']*fixture\.source|import\(\s*["'][^"']*fixture\.source/.test(
          readFileSync(path.join(src, entry), "utf8"),
        ),
      );

    expect(
      offenders,
      "the warm-up series is imported by something that ships, which puts it in the bundle",
    ).toEqual([]);
  });

  /**
   * The line starts at the left edge. Its first vertex is the one before the
   * window, so the curve enters the picture rather than beginning inside it,
   * and there is no dot at its start.
   */
  it("enters at the left edge, with no reading on it", () => {
    const geometry = heroGeometry();
    expect(geometry.vertices[0]!.x).toBe(0);
    expect(geometry.points.every((point) => point.x > 0)).toBe(true);
  });
});

/**
 * "En dagsvikt är mest brus", which is figures rather than a graph (D179).
 *
 * The section makes one arithmetic claim: those fourteen mornings, and this
 * trend. So that is what is checked, recomputed over the whole series by §4.1
 * and formatted the way the page formats it, rather than compared as a float
 * nobody sees.
 */
describe("fourteen mornings, one figure", () => {
  it("shows every reading the fixture has, in order", () => {
    expect(MORNINGS).toHaveLength(FORTNIGHT.shown);
    expect(MORNINGS.map((morning) => morning.localDate)).toEqual(
      FORTNIGHT.readings.map((reading) => reading.localDate),
    );

    /* One decimal, a comma, the way a weight is written everywhere else (§4.1). */
    for (const morning of MORNINGS) {
      expect(morning.reading, `${morning.localDate} is not written as a weight`).toMatch(
        /^\d{2,3},\d$/,
      );
    }
  });

  it("settles on what the calc says for the fourteenth morning", () => {
    const computed = trendByDate(FORTNIGHT_SOURCE.readings);
    const expected = computed.get(SETTLED_TREND_DATE);

    expect(expected, `${SETTLED_TREND_DATE} is not in the computed trend`).toBeDefined();
    expect(SETTLED_TREND).toBe(expected!.toFixed(1).replace(".", ","));
  });

  it("settles on the last morning shown, not some other day", () => {
    expect(SETTLED_TREND_DATE).toBe(MORNINGS.at(-1)!.localDate);
    expect(SETTLED_TREND_DATE).toBe(FORTNIGHT_SOURCE.readings.at(-1)!.localDate);
  });

  /**
   * The trend is not one of the readings. If it were, the section would be
   * showing fourteen numbers and then one of them again, and the argument it
   * makes is that the fourteenth morning's figure is not the answer.
   */
  it("is a figure none of the mornings gave", () => {
    expect(MORNINGS.map((morning) => morning.reading)).not.toContain(SETTLED_TREND);
  });
});
