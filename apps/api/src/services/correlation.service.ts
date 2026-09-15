import type { CorrelationPane, CorrelationsResponse } from "shared";
import {
  buildActivityIndex,
  hasEnoughToPlot,
  KCAL_PER_KG,
  MIN_PAIRS_TO_PLOT,
  MIN_WHOLE_WEEKS,
  pairSeries,
  toNumberOrNull,
  weeklyIntakeAgainstTrend,
  type PairedSeries,
} from "shared";
import type { Db } from "../db/index.js";
import { listActivities, listDailyLogs } from "../repositories/daily.repo.js";
import { resolveIntake } from "./intake.service.js";
import { resolveTrend } from "./series.service.js";
import { currentMaintenance } from "./insights.service.js";

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

export async function getCorrelations(
  userId: string,
  db: Db,
  asOf: string,
): Promise<CorrelationsResponse> {
  const [dailyRows, activityRows, intake, trend, maintenance] = await Promise.all([
    listDailyLogs(userId, db, {}),
    listActivities(userId, db, {}),
    // Both through their owners, so the axes mean the same thing here as on
    // the dashboard and in §4.2 (D47).
    resolveIntake(userId, db, {}),
    resolveTrend(userId, db, asOf),
    currentMaintenance(userId, db, asOf),
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
   * Intake against trend change, **one point per whole calendar week** (D166).
   *
   * This used to be a seven-day mean beside a seven-day trend change on every
   * day, so each point shared six days with the next and a week was drawn as
   * seven overlapping dots, and the change was measured over the same days as
   * the intake although the trend lags the scale by about nine. The weekly calc
   * shifts the span by the lag at this person's cadence and measures it the §4.2
   * way; it is documented, with what the shift cannot do, in `weekly-intake.ts`.
   */
  const weekly = weeklyIntakeAgainstTrend({ trend, intake, asOf });
  const weeklyFirst = weekly.points[0];
  const weeklyLast = weekly.points.at(-1);

  const panes: CorrelationPane[] = [
    toPane("sleep_energy", pairSeries(sleep, energy)),
    toPane("activity_sweat", pairSeries(activityMinutes, sweat)),
    {
      pane: "intake_trend_change",
      pairs: weekly.points.map((point) => ({
        localDate: point.weekStart,
        x: point.meanIntakeKcal,
        y: point.trendChangeKgPerWeek,
        // A week where the eating changed, which the chart draws as a ring
        // because the trend has not finished answering it yet (D170).
        transitional: point.transitional,
      })),
      sampleSize: weekly.points.length,
      unpairedDays: weekly.droppedWeeks,
      range:
        weeklyFirst && weeklyLast ? { from: weeklyFirst.weekStart, to: weeklyLast.weekEnd } : null,
      enough: weekly.points.length >= MIN_WHOLE_WEEKS,
      unit: "week",
      needed: MIN_WHOLE_WEEKS,
      lagDays: weekly.lagDays,
      /**
       * The expected line, only from a measured maintenance figure (D166). A
       * formula's figure is a guess about this body, and a line drawn from it
       * would sit on the chart looking exactly like one drawn from data.
       */
      reference:
        maintenance.source === "adaptive" && maintenance.tdee !== null
          ? { maintenanceKcal: maintenance.tdee, kcalPerKg: KCAL_PER_KG }
          : null,
    },
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
    unit: "day",
    needed: MIN_PAIRS_TO_PLOT,
    lagDays: null,
    reference: null,
  };
}
