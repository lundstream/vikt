import { FORTNIGHT, HERO } from "./fixture.generated.js";

/**
 * The landing page's geometry, from the app's own arithmetic (D177, D178).
 *
 * Every point and every line on this page comes from `fixture.generated.ts`:
 * dated readings, and the trend through them computed by `packages/shared`'s
 * EMA, which is the function the app's chart uses.
 *
 * **Nothing here is drawn by hand.** The hero used to be a cubic with four
 * control points, chosen because it looked like a trend. A page whose whole
 * argument is "this app draws the trend rather than the noise" cannot
 * illustrate it with a shape somebody sketched, and nothing would have noticed
 * if §4.1 changed underneath it. `landing-fixture.test.ts` recomputes both
 * series and fails on any vertex that has moved.
 *
 * ## The curve is the app's curve
 *
 * `TrendChart.tsx` draws its trend with Recharts' `type="monotone"`, which is
 * d3's monotone cubic, and this is the same interpolation over the same values.
 * The page used to join its vertices with straight segments, which on a
 * fortnight of daily readings is a polyline of fourteen corners where the app
 * draws one continuous curve. Monotone rather than a natural cubic for the
 * reason the chart gives: a natural cubic overshoots a gap and draws a weight
 * nobody recorded, and monotone cannot leave the interval between two
 * neighbouring values.
 *
 * ## The window, and the vertex before it
 *
 * Each series is longer than the picture. The trend is computed over all of it
 * and the page draws the last `shown` readings, so the line is already settled
 * when it arrives: §4.1 seeds on the first reading, and a line computed over
 * exactly what is on screen starts **on a point**, at one morning's water
 * weight, then spends a week walking back to the body.
 *
 * The line is drawn from **one vertex before** the first reading shown, which
 * puts its start at the left edge of the box and off the picture. That is what
 * the app's own chart shows for any window of a longer history, and it is why
 * there is no dot marking where the line begins.
 *
 * The window arrives already cut: `fixture.generated.ts` holds the readings the
 * page draws and one trend vertex more, and the readings the trend was warmed
 * up on are in `fixture.source.generated.ts`, which only the test imports. An
 * array literal cannot be tree-shaken element by element, so shipping the whole
 * series meant sending a hundred numbers to a stranger's phone for a picture
 * that does not contain them.
 */

export type Point = { x: number; y: number };

/** A vertex of a drawn trend line, with the value it came from. */
export type Vertex = Point & { localDate: string; trendKg: number };

/**
 * A drawn reading, and the two numbers that let it arrive with the line.
 *
 * The fortnight is drawn by scrolling, so it asks **where** along the line the
 * reading sits. The hero is drawn by the clock, so it asks **when** the line
 * gets there. Those are different numbers because the line eases, and holding
 * only one of them is how a dot ends up behind the curve it is meant to
 * precede.
 */
export type Reading = Point & {
  localDate: string;
  weightKg: number;
  /** Where along the line's length this reading sits, 0 to 1. */
  at: number;
  /**
   * **When** the line gets there, as a fraction of its two seconds.
   *
   * Not the same number as `at`, and the difference is the whole reason this
   * field exists. The line draws on an ease-out, so it covers forty per cent of
   * its length in the first quarter of its time: dots delayed by `at` alone
   * fell behind in the middle of the sequence and were overtaken by the line
   * they were supposed to precede. This is `at` put through the inverse of that
   * easing, so the dot arrives when the line does however the curve is shaped.
   */
  enters: number;
};

export type Geometry = {
  /** The readings the page draws, as the chart's raw dots. */
  points: Reading[];
  /** The trend's vertices, in order, including the one before the window. */
  vertices: Vertex[];
  /** Those vertices as a monotone cubic path. */
  path: string;
};

/**
 * The box, in CSS pixels at the width the page draws these at.
 *
 * A viewBox in its own invented units would mean the stroke width and the dot
 * radius below are not the app's numbers but the app's numbers times whatever
 * the scale happened to be. At 640 they are the same 3 and 2 and 4 that
 * `TrendChart.tsx` passes to Recharts, and below 640 the whole drawing scales
 * together, which keeps the relationship between the line and its points.
 */
export const HERO_BOX = { width: 640, height: 240 } as const;

/** The app's chart's own numbers (`TrendChart.tsx`), used unchanged. */
export const MARKS = {
  /** The signature element: thicker than anything else, round joins. */
  strokeWidth: 3,
  /** Small and quiet, so the evidence does not beat the line it supports. */
  readingRadius: 2,
  /** The chart's active dot, which is what the endpoint is. */
  endpointRadius: 4,
} as const;

/* ------------------------------------------------------------- the easing -- */

/**
 * The hero line's timing function, which `landing.css` also names.
 *
 * The two have to agree, and the way they are kept agreeing is that this is the
 * only place the four numbers are written down in code: the stylesheet's comment
 * points here, and the measurement in `docs/measurements.md` is taken from the
 * browser rather than from either.
 */
const LINE_EASING = [0.33, 0, 0.2, 1] as const;

/** One axis of a cubic Bézier with implicit ends at 0 and 1. */
const bezier = (t: number, a: number, b: number) => {
  const u = 1 - t;
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
};

/**
 * The fraction of the line's **time** at which it has drawn `progress` of its
 * length.
 *
 * Solved by bisection on the curve's parameter rather than algebraically: a
 * cubic has a closed form nobody should read, and forty steps put the answer
 * inside a thousandth of a frame.
 */
function timeAtProgress(progress: number): number {
  const [x1, , x2] = LINE_EASING;
  const [, y1, , y2] = LINE_EASING;

  let low = 0;
  let high = 1;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (bezier(middle, y1, y2) < progress) low = middle;
    else high = middle;
  }
  return bezier((low + high) / 2, x1, x2);
}

/* ------------------------------------------------------- the monotone curve -- */

const sign = (value: number) => (value < 0 ? -1 : 1);

/**
 * The tangent at an interior point, Fritsch and Carlson's rule, exactly as
 * d3-shape computes it for `curveMonotoneX`.
 *
 * The slope is limited to three times the smaller neighbouring secant, which is
 * what makes the result monotone: between two readings the curve cannot leave
 * the interval they bound, so it never draws a weight that was not in the data.
 */
function slope3(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number {
  const h0 = x1 - x0;
  const h1 = x2 - x1;
  const s0 = (y1 - y0) / (h0 || (h1 < 0 ? -0 : 0));
  const s1 = (y2 - y1) / (h1 || (h0 < 0 ? -0 : 0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
}

/** The tangent at an end point, from the one interior tangent beside it. */
function slope2(x0: number, y0: number, x1: number, y1: number, t: number): number {
  const h = x1 - x0;
  return h ? ((3 * (y1 - y0)) / h - t) / 2 : t;
}

const round = (value: number) => Number(value.toFixed(2));

/**
 * The points as one monotone cubic path.
 *
 * Every segment is a cubic whose end point is the next vertex, so the drawn
 * curve passes through every computed value and the control points only decide
 * how it gets between them. `landing-fixture.test.ts` reads those end points
 * back out and compares them with the calc.
 */
function monotonePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;

  const tangents: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i]!;
    const next = points[i + 1];
    if (previous && next) {
      tangents.push(slope3(previous.x, previous.y, current.x, current.y, next.x, next.y));
    } else {
      tangents.push(Number.NaN); // filled in below, from the interior tangent
    }
  }
  tangents[0] = slope2(points[0]!.x, points[0]!.y, points[1]!.x, points[1]!.y, tangents[1]!);
  const last = points.length - 1;
  tangents[last] = slope2(
    points[last - 1]!.x,
    points[last - 1]!.y,
    points[last]!.x,
    points[last]!.y,
    tangents[last - 1]!,
  );

  let path = `M ${round(points[0]!.x)} ${round(points[0]!.y)}`;
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const dx = (to.x - from.x) / 3;
    path +=
      ` C ${round(from.x + dx)} ${round(from.y + dx * tangents[i - 1]!)}` +
      ` ${round(to.x - dx)} ${round(to.y - dx * tangents[i]!)}` +
      ` ${round(to.x)} ${round(to.y)}`;
  }
  return path;
}

/**
 * How far along the whole path each vertex sits, as a fraction of its length.
 *
 * Each cubic is sampled rather than integrated: an exact arc length has no
 * closed form and the answer only has to be good enough to time a dot against
 * the line passing it. Sixteen samples a segment is well under a pixel here.
 */
function lengthFractions(points: readonly Point[], path: string): number[] {
  const segments = path.split(" C ").slice(1);
  const lengths: number[] = [0];

  for (let i = 0; i < segments.length; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const [c1x, c1y, c2x, c2y] = segments[i]!.trim().split(/\s+/).map(Number) as number[];

    let length = 0;
    let previous = from;
    for (let step = 1; step <= 16; step += 1) {
      const t = step / 16;
      const u = 1 - t;
      const at = {
        x: u * u * u * from.x + 3 * u * u * t * c1x! + 3 * u * t * t * c2x! + t * t * t * to.x,
        y: u * u * u * from.y + 3 * u * u * t * c1y! + 3 * u * t * t * c2y! + t * t * t * to.y,
      };
      length += Math.hypot(at.x - previous.x, at.y - previous.y);
      previous = at;
    }
    lengths.push(lengths[i]! + length);
  }

  const total = lengths.at(-1)!;
  return lengths.map((value) => (total === 0 ? 0 : value / total));
}

/* ------------------------------------------------------------- the layout -- */

type Series = {
  /** How many readings this window holds, which is what the page draws. */
  readonly shown: number;
  readonly readings: readonly { readonly localDate: string; readonly weightKg: number }[];
  /** One longer than `readings`: the extra vertex is the one before the window. */
  readonly trend: readonly { readonly localDate: string; readonly trendKg: number }[];
};

/**
 * Lay a window of a series out in a box.
 *
 * The x axis is the date, so a gap between readings is a gap on the page. The y
 * axis holds both series, so the trend sits among its own readings rather than
 * being scaled to itself.
 *
 * There is no left padding: the line starts at the box's own edge, from the
 * vertex before the window, and runs off it.
 */
function layout(series: Series, box: { width: number; height: number }): Geometry {
  const { readings, trend } = series;

  const day = (date: string) => Date.parse(`${date}T12:00:00Z`) / 86_400_000;
  const first = day(trend[0]!.localDate);
  const span = Math.max(1, day(trend.at(-1)!.localDate) - first);

  /* Room on the right for the endpoint, and above and below for a dot. */
  const right = MARKS.endpointRadius + MARKS.strokeWidth;
  const vertical = MARKS.readingRadius + 12;

  const values = [...readings.map((r) => r.weightKg), ...trend.map((t) => t.trendKg)];
  const low = Math.min(...values) - 0.3;
  const high = Math.max(...values) + 0.3;

  const place = (date: string, value: number): Point => ({
    x: round(((day(date) - first) / span) * (box.width - right)),
    y: round(vertical + ((high - value) / (high - low)) * (box.height - vertical * 2)),
  });

  const vertices: Vertex[] = trend.map((point) => ({
    ...place(point.localDate, point.trendKg),
    localDate: point.localDate,
    trendKg: point.trendKg,
  }));

  const path = monotonePath(vertices);
  const fractions = lengthFractions(vertices, path);

  /*
    Reading i shares a date with vertex i + 1: the extra vertex at the front is
    the one before the window. So a reading's place along the line is the
    fraction at its own vertex, which is what times its arrival.
  */
  const points: Reading[] = readings.map((reading, index) => {
    const at = fractions[index + 1]!;
    return {
      ...place(reading.localDate, reading.weightKg),
      localDate: reading.localDate,
      weightKg: reading.weightKg,
      at: Number(at.toFixed(4)),
      enters: Number(timeAtProgress(at).toFixed(4)),
    };
  });

  return { points, vertices, path };
}

export const heroGeometry = (): Geometry => layout(HERO, HERO_BOX);

/* ------------------------------------------------------------- the figures -- */

const swedish = (value: number, decimals: number) => value.toFixed(decimals).replace(".", ",");

/* ---------------------------------------------- fourteen mornings, one figure -- */

/**
 * The fortnight, as figures rather than as a second graph (D179).
 *
 * The hero already shows noise and trend as a picture, and drawing the same
 * argument twice makes the second one decoration. This section states it in
 * numbers instead: fourteen mornings of the same body, and the one figure the
 * app would give you for them.
 */
export const MORNINGS = FORTNIGHT.readings.map((reading) => ({
  localDate: reading.localDate,
  reading: swedish(reading.weightKg, 1),
}));

/** How far apart the fourteen arrive, and therefore when the figure settles. */
export const MORNING_STEP_MS = 80;

/** The readings the trend figure flickers through before it settles. */
export const FLICKER_READINGS = FORTNIGHT.readings
  .slice(-6)
  .map((reading) => swedish(reading.weightKg, 1));

/**
 * What the trend says on the fourteenth morning, which is what it settles on.
 *
 * `landing-fixture.test.ts` recomputes §4.1 over the whole series and fails if
 * this string is not what the calc says for `SETTLED_TREND_DATE`. That check
 * used to be on the vertices of a drawn line; the line is gone and the value
 * is what is left to be right.
 */
export const SETTLED_TREND_DATE = FORTNIGHT.trend.at(-1)!.localDate;
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
