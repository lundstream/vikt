/**
 * Pairing for the correlation view — CLAUDE.md §6 phase 4.
 *
 * **This module deliberately computes no statistic (D34).**
 *
 * No r, no r², no p, no fitted line, no "strong/weak", no arrows. It pairs two
 * daily series on date and reports how many pairs there are and what dates they
 * span. That is the whole contract, and it is a constraint rather than an
 * omission: this is the one screen where a plausible-looking number would do
 * real damage.
 *
 * Why. Every pair here is one person's self-report over a few weeks, and the
 * candidate relationships all have obvious third causes. Sleep against energy
 * is confounded by the working week, by illness, by whether the day was already
 * going badly when both were rated. Intake against trend change is confounded
 * by salt, by glycogen, by the coverage of the food log itself — and a stretch
 * of poor logging moves both axes at once. An r of 0.41 over 23 self-rated days
 * looks like a finding, and it is not one; worse, it is the kind of thing that
 * gets acted on, because a number on a chart reads as evidence in a way that
 * the same claim in prose would not.
 *
 * The honest thing a scatter of 23 points does is let someone look at it. So
 * this shows the points, the count and the range, and lets the person draw
 * their own conclusion — or fail to, which is often the correct outcome.
 *
 * If a later change wants a trend line here, that is a decision to reopen D34
 * on purpose, not a tweak to a chart component.
 *
 * Pure. No I/O, no clock.
 */

/** One day where both series have a value. */
export type Pair = {
  localDate: string;
  x: number;
  y: number;
};

export type PairedSeries = {
  pairs: Pair[];
  /** How many days had both values. Shown, always, next to the chart. */
  sampleSize: number;
  /** Inclusive bounds of the paired days, or null when there are none. */
  range: { from: string; to: string } | null;
  /**
   * Days where one series had a value and the other did not. Shown so the
   * sample does not look more complete than it is.
   */
  unpairedDays: number;
};

/**
 * Inner join two dated series on `localDate`.
 *
 * An inner join, not an outer one filled with zeroes: a day with no sleep
 * rating is a day we know nothing about, not a day of no sleep. That is the
 * same rule intake resolution follows, and getting it wrong here would not
 * produce an error, it would produce a cloud of points at x=0 that looks like a
 * pattern.
 */
export function pairSeries(
  x: ReadonlyMap<string, number | null>,
  y: ReadonlyMap<string, number | null>,
): PairedSeries {
  const pairs: Pair[] = [];
  let unpairedDays = 0;

  const days = new Set([...x.keys(), ...y.keys()]);
  for (const localDate of [...days].sort()) {
    const xValue = x.get(localDate) ?? null;
    const yValue = y.get(localDate) ?? null;

    if (xValue === null || yValue === null) {
      if (xValue !== null || yValue !== null) unpairedDays += 1;
      continue;
    }
    if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) continue;

    pairs.push({ localDate, x: xValue, y: yValue });
  }

  const first = pairs[0];
  const last = pairs.at(-1);

  return {
    pairs,
    sampleSize: pairs.length,
    range: first && last ? { from: first.localDate, to: last.localDate } : null,
    unpairedDays,
  };
}

/**
 * How many paired days before a scatter is worth drawing at all.
 *
 * Not a significance threshold — there is no test here to be significant. It is
 * the point below which a handful of dots reads as a shape that is not there.
 * Under it the UI says how many days it has and how many it wants, in the same
 * way the dashboard's pre-data state does, rather than showing four points.
 */
export const MIN_PAIRS_TO_PLOT = 14;

export function hasEnoughToPlot(series: PairedSeries): boolean {
  return series.sampleSize >= MIN_PAIRS_TO_PLOT;
}
