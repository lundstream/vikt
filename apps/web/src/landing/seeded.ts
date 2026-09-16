/**
 * Every number the landing page draws, from a fixed seed (D173).
 *
 * Two rules this file exists to keep:
 *
 * **Identical on every load.** A hero that scatters its points differently each
 * time is a page that looks broken to anybody who reloads it, and it makes a
 * screenshot test impossible to write. `mulberry32` with a constant seed is
 * four lines and gives the same sequence in every browser, forever.
 *
 * **Never a real account.** The figures here are a fixture, not somebody's
 * body: the landing page is public, and D9's whole position is that this data
 * belongs to the person who logged it. The shapes are plausible because they
 * are generated the way the app's own fixtures are, from a maintenance figure
 * and 7 700 kcal per kilo, not because they were copied off a screen.
 */

/** Small, fast, and identical everywhere. The constant is the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Point = { x: number; y: number };

/** The hero graph's own coordinate space. Unitless: the SVG scales itself. */
export const HERO_BOX = { width: 320, height: 170 } as const;

/**
 * The invisible path the readings scatter around, as a cubic through four
 * control points: a trend that falls and flattens, which is the shape this
 * product is about. The line the hero draws is this path, not a fit of the
 * points, for the same reason Samband draws arithmetic rather than a
 * regression (D34).
 */
const HERO_CURVE = "M 8 34 C 86 44, 120 96, 180 106 S 268 132, 312 128";

export function heroPath(): string {
  return HERO_CURVE;
}

/**
 * About thirty readings scattered around that curve.
 *
 * Scattered vertically only, because that is how a scale is wrong: a reading is
 * taken on the day it is taken, and it is the weight that swings with salt and
 * water. A cloud scattered in both directions would be a picture of noise
 * rather than a picture of weighing.
 */
export function heroPoints(count = 30): Point[] {
  const random = mulberry32(20260917);
  const points: Point[] = [];

  for (let index = 0; index < count; index += 1) {
    const t = index / (count - 1);
    const x = 8 + t * (HERO_BOX.width - 16);
    // The curve, sampled coarsely enough to be cheap and finely enough to look
    // like the line it will become.
    const base = 34 + 72 * t + 18 * Math.sin(t * Math.PI * 0.9) - 12 * t * t;
    const swing = (random() - 0.5) * 26;
    points.push({ x: Number(x.toFixed(1)), y: Number((base + swing).toFixed(1)) });
  }

  return points;
}

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

/* ------------------------------------------------ a fortnight of weighing -- */

export const NOISE_BOX = { width: 320, height: 150 } as const;

/**
 * Fourteen daily readings around a trend that falls by about 0,4 kg over the
 * fortnight, and the trend itself.
 *
 * Built the way `calc/fixtures.ts` builds a body: a starting weight, a steady
 * small deficit, and a daily swing that is water rather than fat. The swing is
 * deliberately larger than the trend change, which is the entire point of the
 * section it illustrates.
 */
function fortnight(): { readings: number[]; trend: number[] } {
  const random = mulberry32(140314);
  const readings: number[] = [];
  const trend: number[] = [];

  let smoothed = 84.6;
  for (let day = 0; day < 14; day += 1) {
    const underlying = 84.6 - day * 0.031;
    const reading = underlying + (random() - 0.5) * 1.7;
    // §4.1's shape, at §4.1's alpha, so the line here behaves like the app's.
    smoothed = day === 0 ? reading : smoothed + 0.1 * (reading - smoothed);
    readings.push(Number(reading.toFixed(1)));
    trend.push(Number(smoothed.toFixed(2)));
  }

  return { readings, trend };
}

export const FORTNIGHT = fortnight();

/** The readings the hero number flickers through before it settles. */
export const FLICKER_READINGS = FORTNIGHT.readings.slice(-6).map((value) => value.toFixed(1));

/** What the trend says at the end of it, which is what the number settles on. */
export const SETTLED_TREND = FORTNIGHT.trend[FORTNIGHT.trend.length - 1]!.toFixed(1);

/** Points and a path for the fortnight graph, in `NOISE_BOX` coordinates. */
export function fortnightGeometry(): { points: Point[]; path: string } {
  const values = [...FORTNIGHT.readings, ...FORTNIGHT.trend];
  const low = Math.min(...values) - 0.3;
  const high = Math.max(...values) + 0.3;

  const place = (value: number, index: number): Point => ({
    x: Number((14 + (index / 13) * (NOISE_BOX.width - 28)).toFixed(1)),
    y: Number((18 + ((high - value) / (high - low)) * (NOISE_BOX.height - 36)).toFixed(1)),
  });

  const points = FORTNIGHT.readings.map(place);
  const path = FORTNIGHT.trend
    .map(place)
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");

  return { points, path };
}

/* ------------------------------------------------------- the two figures -- */

/**
 * The formula's guess and the measured figure, for "Underhåll mäts, inte
 * räknas".
 *
 * A fixture, and a realistic gap: the Mifflin-St Jeor figure for a body this
 * size sits a few hundred kilocalories from what twenty-eight days of logging
 * says, in either direction, and the whole argument of §4.2 is that only one of
 * the two corrects itself.
 */
const MEASURED_DAYS = 28;
const MEASURED_COVERAGE_PERCENT = 86;

export const MAINTENANCE = {
  formula: 2310,
  measured: 2536,
  /**
   * The labels are built here rather than interpolated in the JSX.
   *
   * `number-formatting.test.ts` refuses a bare number interpolated into
   * rendered output, and it is right to: every figure a reader sees goes
   * through the app's formatter or is written as text. These two are a
   * fixture's own description, so they are text, and the figures above and the
   * words below still have one source between them.
   */
  formulaLabel: "formel, ur längd, vikt, ålder och kön",
  measuredLabel: `uppmätt ur ${MEASURED_DAYS} dagar, ${MEASURED_COVERAGE_PERCENT} % loggat`,
} as const;
