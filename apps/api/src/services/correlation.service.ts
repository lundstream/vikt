import type { CorrelationPane, CorrelationsResponse } from "shared";
import {
  buildActivityIndex,
  hasEnoughToPlot,
  intakeOn,
  MIN_PAIRS_TO_PLOT,
  pairSeries,
  toNumberOrNull,
  type PairedSeries,
} from "shared";
import type { Db } from "../db/index.js";
import { listActivities, listDailyLogs } from "../repositories/daily.repo.js";
import { resolveIntake } from "./intake.service.js";
import { resolveTrend } from "./series.service.js";

/**
 * The deep-dive screen's data.
 *
 * **No statistic is computed here and none is returned (D34).** This assembles
 * three pairs of daily series, joins each on date, and reports the points, the
 * sample size, the unpaired days and the range. The joining itself lives in
 * `calc/correlate.ts`; this file only decides which series go on which axis.
 *
 * The temptation this guards against is specific: an r of 0.41 over 23
 * self-rated days looks like a finding on a chart in a way the same claim in
 * prose would not, and it is the kind of thing that gets acted on.
 */

/** Days a day's trend change is measured across. One day is mostly water. */
const TREND_CHANGE_WINDOW_DAYS = 7;

export async function getCorrelations(
  userId: string,
  db: Db,
  asOf: string,
): Promise<CorrelationsResponse> {
  const [dailyRows, activityRows, intake, trend] = await Promise.all([
    listDailyLogs(userId, db, {}),
    listActivities(userId, db, {}),
    // Both through their owners, so the axes mean the same thing here as on
    // the dashboard and in §4.2 (D47).
    resolveIntake(userId, db, {}),
    resolveTrend(userId, db, asOf),
  ]);

  /** Absent stays absent: a day with no rating is not a day rated zero. */
  const scale = (pick: (row: (typeof dailyRows)[number]) => number | null) =>
    new Map(dailyRows.map((row) => [row.localDate, pick(row)]));

  const sleep = new Map(
    dailyRows.map((row) => [row.localDate, toNumberOrNull(row.sleepHours)]),
  );
  const energy = scale((row) => row.energy);
  const sweat = scale((row) => row.sweat);

  /**
   * Activity minutes, not the kcal estimate. Minutes are measured; the kcal
   * figure is a MET guess, and putting it on an axis would quietly make an
   * estimate look like data (D33).
   */
  const activityIndex = buildActivityIndex(
    activityRows.map((row) => ({
      localDate: row.localDate,
      durationMin: row.durationMin,
      kcalEstimate: row.kcalEstimate,
    })),
  );
  const activityMinutes = new Map(
    [...activityIndex].map(([localDate, day]) => [localDate, day.minutes]),
  );

  /**
   * Change in the smoothed line over the previous week, in kg, per day.
   *
   * A single day's trend change against a single day's intake is a scatter of
   * noise: the trend moves a few grams a day and the smoothing means today's
   * point already contains last week's eating. A week of change against the
   * same week's mean intake is the comparison someone actually means.
   */
  const trendChange = new Map<string, number | null>();
  for (const [index, point] of trend.entries()) {
    const earlier = trend[index - TREND_CHANGE_WINDOW_DAYS];
    trendChange.set(point.localDate, earlier ? point.trend - earlier.trend : null);
  }

  const meanIntake = new Map<string, number | null>();
  for (const [index, point] of trend.entries()) {
    const window = trend.slice(Math.max(0, index - TREND_CHANGE_WINDOW_DAYS + 1), index + 1);
    const logged = window
      .map((day) => intakeOn(intake, day.localDate))
      .filter((kcal): kcal is number => kcal !== null);

    // The §4.2 rule, again: divide by the days that were logged, never by the
    // days in the window. An unlogged day is not a day of zero calories.
    meanIntake.set(
      point.localDate,
      logged.length === 0 ? null : logged.reduce((a, b) => a + b, 0) / logged.length,
    );
  }

  const panes: CorrelationPane[] = [
    toPane("sleep_energy", pairSeries(sleep, energy)),
    toPane("activity_sweat", pairSeries(activityMinutes, sweat)),
    toPane("intake_trend_change", pairSeries(meanIntake, trendChange)),
  ];

  return {
    asOf,
    panes,
    minPairs: MIN_PAIRS_TO_PLOT,
    dailyLogDays: dailyRows.length,
  };
}

function toPane(pane: CorrelationPane["pane"], series: PairedSeries): CorrelationPane {
  return {
    pane,
    pairs: series.pairs,
    sampleSize: series.sampleSize,
    unpairedDays: series.unpairedDays,
    range: series.range,
    enough: hasEnoughToPlot(series),
  };
}
