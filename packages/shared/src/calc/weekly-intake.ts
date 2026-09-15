/**
 * Intake against trend change, one point per calendar week (D166).
 *
 * The daily version of this pane put a seven-day mean of intake beside a
 * seven-day change in the trend on **every** day, so each point shared six days
 * with the next one and a week of eating was drawn as seven overlapping dots.
 * Worse, it measured the trend over the same seven days as the intake, and the
 * trend lags the scale by about nine days at a daily cadence (§4.1, D36), so
 * most of the change it plotted belonged to the week before.
 *
 * So:
 *
 * - **One point per whole calendar week, Monday to Sunday.** A week still in
 *   progress is not a week.
 * - **The week needs §4.2's coverage**: at least `COVERAGE_GATE` of its days
 *   with intake logged, and the mean is taken over the logged days only, never
 *   over seven.
 * - **The trend change is shifted by the lag** at the cadence this person
 *   actually weighs in (`trendLagDays`), and measured the §4.2 way: between the
 *   first and last reading inside the shifted week, divided by the days between
 *   them, and stated per week. A week whose shifted end is still in the future
 *   has no change to measure yet.
 *
 * **What the shift does not do.** The trend is an exponential average, so it
 * does not delay a week's change so much as smear it across the following ten
 * days, and no shift undoes a smear. Measured on a synthetic body that obeys
 * 7700 kcal per kg exactly (`weekly-intake.test.ts`): where intake has held for
 * longer than the lag, points land within 0.08 kg per week of the expected line.
 * In the week after a change in intake the shift roughly halves the miss, from
 * about 0.3 to 0.13 kg per week, and in the last week before the next change it
 * makes the miss worse, because the shifted span reaches into the new level.
 * The screen says so: distance from the line near a change is the trend
 * catching up, not the body disagreeing with the arithmetic.
 *
 * **No statistic is computed (D34).** The expected line the screen draws is not
 * fitted to these points; it is `expectedChangeKgPerWeek`, arithmetic on the
 * measured maintenance figure and 7700 kcal per kg, and it would be the same
 * line with no points on the chart at all.
 *
 * Pure. No I/O, no clock.
 */
import { hasIntakeOn, intakeOn, type IntakeIndex } from "./intake.js";
import { COVERAGE_GATE, KCAL_PER_KG } from "./tdee.js";
import { addDays, trendLagDays, type TrendPoint } from "./trend.js";

/** How many whole weeks before the pane draws anything. */
export const MIN_WHOLE_WEEKS = 4;

/** Days a week has to have intake on, from §4.2's gate: 0.8 of 7, rounded up. */
export const MIN_LOGGED_DAYS_PER_WEEK = Math.ceil(COVERAGE_GATE * 7);

/** A shifted week needs readings this far apart to have a rate at all. */
const MIN_SPAN_DAYS = 4;

/**
 * A week-over-week change in mean intake at or above this is a **transitional**
 * week, drawn as a ring rather than a filled point (D170).
 *
 * Derived rather than chosen, on the synthetic body `weekly-intake.test.ts` and
 * the Samband fixture both use: six weeks at one level, six at another, and the
 * step between them varied. How far the week of the change lands from the
 * expected line:
 *
 *   step   100    200    300    400    500    600    800
 *   off   0.025  0.051  0.077  0.103  0.130  0.156  0.208   kg per week
 *
 * 0.1 kg per week is where a point stops being on the line at this chart's
 * scale, and 400 kcal is the first step that crosses it. The fixture's own step
 * is 800, comfortably past it.
 *
 * **Two things this does not mark, deliberately.** The first week of any history
 * sits about 0.13 off the line because the trend is still warming up from its
 * seed, which is not a change in eating and has no previous week to compare
 * with. And the week *before* a change is off the line too, often further: its
 * lag-shifted span reaches into the next level, which the tests above pin. Both
 * are about the trend catching up, which is what the note under the chart says
 * in words; the ring marks only the week where the intake actually moved.
 */
export const TRANSITIONAL_INTAKE_CHANGE_KCAL = 400;

export type WeekPoint = {
  /** The Monday. */
  weekStart: string;
  /** The Sunday. */
  weekEnd: string;
  /** Mean over the days with intake logged (§4.2). */
  meanIntakeKcal: number;
  daysLogged: number;
  /** Change in the trend over the lag-shifted week, kg per week. */
  trendChangeKgPerWeek: number;
  /**
   * Whether mean intake moved by at least `TRANSITIONAL_INTAKE_CHANGE_KCAL`
   * from the previous week with a point. The first point is never one: there is
   * nothing to have changed from.
   */
  transitional: boolean;
};

export type WeeklyIntakeAgainstTrend = {
  points: WeekPoint[];
  /** Whole weeks that had intake but too few logged days, or no measurable change. */
  droppedWeeks: number;
  /** The shift applied, in whole days. */
  lagDays: number;
};

/** 0 for Monday through 6 for Sunday, for a `YYYY-MM-DD`. */
function weekdayIndex(localDate: string): number {
  return (new Date(`${localDate}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000,
  );
}

/**
 * The typical gap between readings, as the median over the last 28 days of
 * readings, so one holiday does not move the lag for everyone else's weeks.
 */
function typicalGapDays(readings: readonly TrendPoint[]): number {
  const recent = readings.slice(-29);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    gaps.push(daysBetween(recent[i - 1]!.localDate, recent[i]!.localDate));
  }
  if (gaps.length === 0) return 1;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)]!;
}

/**
 * The line the screen draws: what 7700 kcal per kg says a week at this intake
 * should do to the trend, given a measured maintenance figure.
 */
export function expectedChangeKgPerWeek(meanIntakeKcal: number, maintenanceKcal: number): number {
  return (7 * (meanIntakeKcal - maintenanceKcal)) / KCAL_PER_KG;
}

export function weeklyIntakeAgainstTrend(input: {
  trend: readonly TrendPoint[];
  intake: IntakeIndex;
  asOf: string;
  /** Replace the lag derived from cadence. Tests and nothing else. */
  lagDays?: number;
}): WeeklyIntakeAgainstTrend {
  const history = input.trend.filter((point) => point.localDate <= input.asOf);
  const readings = history.filter((point) => point.raw !== null);
  const lagDays = input.lagDays ?? Math.round(trendLagDays(typicalGapDays(readings)));

  if (history.length === 0) return { points: [], droppedWeeks: 0, lagDays };

  const byDate = new Map(history.map((point) => [point.localDate, point]));
  const first = history[0]!.localDate;

  // The first Monday on or after the first day of history: a week that started
  // before anything was recorded is not a whole week of it.
  const firstMonday = addDays(first, (7 - weekdayIndex(first)) % 7);

  const points: WeekPoint[] = [];
  let droppedWeeks = 0;

  for (let weekStart = firstMonday; ; weekStart = addDays(weekStart, 7)) {
    const weekEnd = addDays(weekStart, 6);
    // Whole weeks only: the Sunday has to be over.
    if (weekEnd >= input.asOf) break;

    const days = Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset));
    const logged = days.filter((day) => hasIntakeOn(input.intake, day));
    if (logged.length === 0) continue;

    if (logged.length < MIN_LOGGED_DAYS_PER_WEEK) {
      droppedWeeks += 1;
      continue;
    }

    // The trend's answer to this week arrives `lagDays` later. A shifted week
    // that ends after today has not answered yet.
    const shiftedStart = addDays(weekStart, lagDays - 1);
    const shiftedEnd = addDays(weekEnd, lagDays);
    if (shiftedEnd > input.asOf) break;

    const inside = readings.filter(
      (point) => point.localDate >= shiftedStart && point.localDate <= shiftedEnd,
    );
    const firstReading = inside[0];
    const lastReading = inside.at(-1);
    const span =
      firstReading && lastReading ? daysBetween(firstReading.localDate, lastReading.localDate) : 0;

    if (!firstReading || !lastReading || span < MIN_SPAN_DAYS) {
      droppedWeeks += 1;
      continue;
    }

    const start = byDate.get(firstReading.localDate)!.trend;
    const end = byDate.get(lastReading.localDate)!.trend;
    const total = logged.reduce((sum, day) => sum + (intakeOn(input.intake, day) ?? 0), 0);

    const meanIntakeKcal = total / logged.length;
    const previous = points.at(-1);

    points.push({
      weekStart,
      weekEnd,
      meanIntakeKcal,
      daysLogged: logged.length,
      trendChangeKgPerWeek: (7 * (end - start)) / span,
      /**
       * Against the previous **point**, not the previous calendar week: a week
       * dropped for coverage has no mean to compare with, and comparing across
       * the gap is the honest reading of "what changed since the last week this
       * chart shows".
       */
      transitional:
        previous !== undefined &&
        Math.abs(meanIntakeKcal - previous.meanIntakeKcal) >= TRANSITIONAL_INTAKE_CHANGE_KCAL,
    });
  }

  return { points, droppedWeeks, lagDays };
}
