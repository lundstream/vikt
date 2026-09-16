#!/usr/bin/env node
/**
 * The landing page's two graphs, computed rather than drawn (D177).
 *
 *   pnpm --filter api landing-fixture
 *
 * Writes two files, and the split is the point:
 *
 *   `fixture.generated.ts`        what the page draws, and all it ships
 *   `fixture.source.generated.ts` every reading, for the test to recompute from
 *
 * Both hold dated readings and the trend through them **from
 * `packages/shared`'s own EMA**, which is the function the app's chart uses.
 *
 * ## Why two files
 *
 * The trend is computed over twice the readings the page shows, so that the
 * line is settled before the picture starts. Those extra readings are input to
 * an arithmetic that happens here, at build time: the browser has no use for
 * them, and an array literal cannot be tree-shaken element by element, so
 * keeping them in one file shipped a hundred numbers to a stranger on a phone
 * for nothing. The budget is 60 kB and it was at 59,6.
 *
 * The test imports the source file, recomputes §4.1 over the whole series, and
 * compares against the window the page ships. Nothing is lost by the split: the
 * guarantee is still that the drawn vertices equal the calc's values.
 *
 * ## Why this is generated rather than imported
 *
 * The page could call `computeTrend` in the browser. It would be honest and it
 * would put §4.1 and its dependencies into a bundle that exists to show a
 * stranger one picture. Generating the numbers keeps the page at a list of
 * coordinates, and `landing-fixture.test.ts` runs the same calc over the same
 * readings and fails if a single vertex differs. The guarantee is the test, not
 * the comment.
 *
 * ## Why it is not a drawn curve
 *
 * It was one: a cubic with four control points, chosen because it looked like a
 * trend. A landing page whose whole argument is "this app draws the trend
 * rather than the noise" cannot illustrate it with a shape somebody drew by
 * hand, and nothing would have caught it if the app's smoothing changed.
 *
 * ## Why each series is longer than the picture (D178)
 *
 * §4.1 seeds the trend on the first reading: `trend[0] = weight[0]`. A line
 * computed over exactly the readings on screen therefore **starts on a point**,
 * at whatever that morning's water weight happened to be, and spends its first
 * week walking back to where the body actually is. That is an artefact of where
 * the picture was cropped, not something the app does.
 *
 * So each series is computed over more readings than are drawn: sixty for the
 * hero and forty-two days for the fortnight, of which the last thirty and the
 * last fourteen are shown. The line is already settled among its points when it
 * enters at the left edge, which is what the app's own chart shows for any
 * window of a longer history.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/*
  The source, by path. `scripts/` is not a workspace package and has no
  dependency on `shared`; tsx loads the TypeScript directly, and the point of
  this script is to use the app's own §4.1 rather than a copy of it.
*/
import { computeTrend } from "../packages/shared/src/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "apps/web/src/landing/fixture.generated.ts");
const SOURCE_OUT = path.join(ROOT, "apps/web/src/landing/fixture.source.generated.ts");

/** The same generator the page used before, so the picture does not change. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const addDays = (date, days) => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

/**
 * The hero: four months of a body that is losing weight, weighed every other
 * day. Sixty readings, of which the page draws the last thirty.
 *
 * Every other day is the cadence the smoothing is built for: §4.1's alpha is
 * **per day**, so a gap compounds it, and weighing every third day turns a
 * ten-day constant into an effective 0,27 that chases the noise instead of
 * cutting through it. At every other day it is 0,19 and
 * the line reads as a trend, which is the thing the page is about.
 *
 * The scatter is the daily swing a real scale shows, and it is the **same**
 * scatter as the fortnight below: the two pictures are of one body, and a hero
 * that swung twice as wide said the noise gets smaller when you look at it for
 * longer, which is the opposite of the argument.
 */
function heroReadings() {
  const random = mulberry32(20260917);
  const start = "2026-05-20";
  const readings = [];

  for (let day = 0; day < 120; day += 2) {
    const underlying = 94.2 - day * 0.031;
    const swing = (random() - 0.5) * 0.95;
    readings.push({
      localDate: addDays(start, day),
      weightKg: Number((underlying + swing).toFixed(1)),
    });
  }

  return readings;
}

/**
 * The fortnight: forty-two consecutive mornings, of which the page draws the
 * last fourteen.
 *
 * The scatter is about 0,8 kg from the trend, which is what a day to day swing
 * actually looks like. The first version scattered by 1,7 and drew a cloud
 * nobody would recognise from their own bathroom scale.
 */
function fortnightReadings() {
  const random = mulberry32(140314);
  const start = "2026-07-27";
  const readings = [];

  for (let day = 0; day < 42; day += 1) {
    const underlying = 85.5 - day * 0.031;
    const swing = (random() - 0.5) * 0.8;
    readings.push({
      localDate: addDays(start, day),
      weightKg: Number((underlying + swing).toFixed(1)),
    });
  }

  return readings;
}

/** `computeTrend` returns a point per day; the page draws the days with a reading. */
function trendFor(readings) {
  const byDate = new Map(computeTrend(readings).map((point) => [point.localDate, point.trend]));
  return readings.map((reading) => ({
    localDate: reading.localDate,
    trendKg: Number(byDate.get(reading.localDate).toFixed(3)),
  }));
}

/** How much of each series reaches the page. The rest is warm-up. */
const HERO_SHOWN = 30;
const FORTNIGHT_SHOWN = 14;

/** What the drawn window actually looks like, so a bad fixture is visible here. */
const spread = (readings, trend, shown) => {
  const byDate = new Map(trend.map((point) => [point.localDate, point.trendKg]));
  const drawn = readings.slice(-shown);
  return Math.max(...drawn.map((r) => Math.abs(r.weightKg - byDate.get(r.localDate)))).toFixed(2);
};

const hero = heroReadings();
const fortnight = fortnightReadings();

const rows = (list, format) => list.map(format).join("\n");
const reading = (r) => `    { localDate: "${r.localDate}", weightKg: ${r.weightKg} },`;
const vertex = (t) => `    { localDate: "${t.localDate}", trendKg: ${t.trendKg} },`;

/**
 * The window the page draws.
 *
 * `lead` is how many trend vertices before the first shown reading to carry.
 * The hero draws a line and takes one, which is what puts its start at the left
 * edge of the box rather than on a point. The fortnight draws no line any more
 * (D179): it states its readings as figures and its trend as one number, so it
 * takes none.
 */
const drawn = (name, readings, trend, shown, lead) =>
  `export const ${name} = {
  /** How many readings this window holds, which is what the page draws. */
  shown: ${shown},
  readings: [
${rows(readings.slice(-shown), reading)}
  ],
  trend: [
${rows(trend.slice(-(shown + lead)), vertex)}
  ],
} as const;`;

/** The whole series, warm-up included. Imported by the test and by nothing else. */
const whole = (name, readings, trend, shown) =>
  `export const ${name} = {
  /** How many of the readings below the page draws, from the end. */
  shown: ${shown},
  readings: [
${rows(readings, reading)}
  ],
  trend: [
${rows(trend, vertex)}
  ],
} as const;`;

const heroTrend = trendFor(hero);
const fortnightTrend = trendFor(fortnight);

const BELONGS = ` * Fixtures, never an account: the landing page is public and D9 says this data
 * belongs to whoever logged it.`;

writeFileSync(
  OUT,
  `/**
 * Generated by \`scripts/landing-fixture.mjs\`. Do not edit by hand.
 *
 * **What the page draws, and all it ships.** Each window is the last \`shown\`
 * readings and the trend from one vertex before them; the readings the trend
 * was warmed up on are in \`fixture.source.generated.ts\`, which the page never
 * imports.
 *
 * \`landing-fixture.test.ts\` recomputes §4.1 over the whole series and fails on
 * any vertex here that differs, so an edit to this file is caught rather than
 * believed.
 *
${BELONGS}
 */

${drawn("HERO", hero, heroTrend, HERO_SHOWN, 1)}

${drawn("FORTNIGHT", fortnight, fortnightTrend, FORTNIGHT_SHOWN, 0)}
`,
  "utf8",
);

writeFileSync(
  SOURCE_OUT,
  `/**
 * Generated by \`scripts/landing-fixture.mjs\`. Do not edit by hand.
 *
 * **Every reading, warm-up included.** Imported by \`landing-fixture.test.ts\`
 * and by nothing that ships: the trend is computed over all of this so the line
 * is settled before the picture starts, and the browser has no use for the part
 * that is not drawn.
 *
${BELONGS}
 */

${whole("HERO_SOURCE", hero, heroTrend, HERO_SHOWN)}

${whole("FORTNIGHT_SOURCE", fortnight, fortnightTrend, FORTNIGHT_SHOWN)}
`,
  "utf8",
);

process.stdout.write(
  `wrote ${path.relative(ROOT, OUT)}: hero ${hero.length} readings, ${HERO_SHOWN} drawn, scatter ${spread(hero, heroTrend, HERO_SHOWN)} kg; fortnight ${fortnight.length} readings, ${FORTNIGHT_SHOWN} drawn, scatter ${spread(fortnight, fortnightTrend, FORTNIGHT_SHOWN)} kg\n`,
);
