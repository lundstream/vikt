import { FORTNIGHT, HERO } from "./fixture.generated.js";

/**
 * The landing page's geometry, from the app's own arithmetic (D177).
 *
 * Every point and every line on this page comes from
 * `fixture.generated.ts`: dated readings, and the trend through them computed by
 * `packages/shared`'s EMA, which is the function the app's chart uses.
 *
 * **Nothing here is drawn by hand.** The hero used to be a cubic with four
 * control points, chosen because it looked like a trend. A page whose whole
 * argument is "this app draws the trend rather than the noise" cannot
 * illustrate it with a shape somebody sketched, and nothing would have noticed
 * if §4.1 changed underneath it. `landing-fixture.test.ts` recomputes both
 * series and fails on any vertex that has moved.
 *
 * The drifting field below is the one exception, and it is not data: it is
 * texture, seeded so it is identical on every load.
 */

export type Point = { x: number; y: number };

/** A vertex of a drawn trend line, with the value it came from. */
export type Vertex = Point & { localDate: string; trendKg: number };

export type Geometry = {
  /** The daily readings, as the chart's raw dots. */
  points: Point[];
  /** The trend's vertices, in order. */
  vertices: Vertex[];
  /** Those vertices as an SVG path. */
  path: string;
};

/** Small, fast, identical everywhere. Used for the decorative field only. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const HERO_BOX = { width: 320, height: 150 } as const;
export const NOISE_BOX = { width: 320, height: 150 } as const;

/**
 * Lay a series out in a box.
 *
 * The x axis is the date, so a gap between readings is a gap on the page: this
 * body weighs in every third day and the dots are evenly spaced because the
 * weighing was. The y axis holds both series, so the trend sits among its own
 * readings rather than being scaled to itself.
 */
function layout(
  readings: readonly { localDate: string; weightKg: number }[],
  trend: readonly { localDate: string; trendKg: number }[],
  box: { width: number; height: number },
  padding = 16,
): Geometry {
  const days = (date: string) =>
    (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${readings[0]!.localDate}T12:00:00Z`)) / 86_400_000;

  const span = Math.max(1, days(readings.at(-1)!.localDate));
  const values = [...readings.map((r) => r.weightKg), ...trend.map((t) => t.trendKg)];
  const low = Math.min(...values) - 0.4;
  const high = Math.max(...values) + 0.4;

  const place = (date: string, value: number): Point => ({
    x: Number((padding + (days(date) / span) * (box.width - padding * 2)).toFixed(2)),
    y: Number((padding + ((high - value) / (high - low)) * (box.height - padding * 2)).toFixed(2)),
  });

  const vertices: Vertex[] = trend.map((point) => ({
    ...place(point.localDate, point.trendKg),
    localDate: point.localDate,
    trendKg: point.trendKg,
  }));

  return {
    points: readings.map((reading) => place(reading.localDate, reading.weightKg)),
    vertices,
    path: vertices.map((v, i) => `${i === 0 ? "M" : "L"} ${v.x} ${v.y}`).join(" "),
  };
}

export const heroGeometry = (): Geometry => layout(HERO.readings, HERO.trend, HERO_BOX);
export const fortnightGeometry = (): Geometry => layout(FORTNIGHT.readings, FORTNIGHT.trend, NOISE_BOX);

/**
 * The drifting field behind the hero: sparse, slow, and the background rather
 * than the subject, which is the one case §5 lets move without stopping.
 */
export function driftField(count = 18): (Point & { delay: number; duration: number })[] {
  const random = mulberry32(7717);
  return Array.from({ length: count }, () => ({
    x: Number((random() * 100).toFixed(2)),
    y: Number((random() * 100).toFixed(2)),
    delay: Number((random() * -24).toFixed(2)),
    duration: Number((22 + random() * 16).toFixed(2)),
  }));
}

/* ------------------------------------------------------------- the figures -- */

const swedish = (value: number, decimals: number) =>
  value.toFixed(decimals).replace(".", ",");

/** The readings the hero number flickers through before it settles. */
export const FLICKER_READINGS = FORTNIGHT.readings
  .slice(-6)
  .map((reading) => swedish(reading.weightKg, 1));

/** What the trend says at the end of the fortnight, which is what it settles on. */
export const SETTLED_TREND = swedish(FORTNIGHT.trend.at(-1)!.trendKg, 1);

/**
 * The formula's guess and the measured figure.
 *
 * A fixture, and a realistic gap: the Mifflin-St Jeor figure for a body this
 * size sits a few hundred kilocalories from what twenty-eight days of logging
 * says, and the whole argument of §4.2 is that only one of the two corrects
 * itself.
 */
const MEASURED_DAYS = 28;
const MEASURED_COVERAGE_PERCENT = 86;

export const MAINTENANCE = {
  formula: 2310,
  measured: 2536,
  formulaLabel: "formel, ur längd, vikt, ålder och kön",
  measuredLabel: `uppmätt ur ${MEASURED_DAYS} dagar, ${MEASURED_COVERAGE_PERCENT} % loggat`,
} as const;
