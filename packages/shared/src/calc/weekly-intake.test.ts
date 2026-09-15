import { describe, expect, it } from "vitest";
import { KCAL_PER_KG } from "./tdee.js";
import { addDays, computeTrend } from "./trend.js";
import {
  expectedChangeKgPerWeek,
  MIN_LOGGED_DAYS_PER_WEEK,
  MIN_WHOLE_WEEKS,
  weeklyIntakeAgainstTrend,
  type WeekPoint,
} from "./weekly-intake.js";

/**
 * Intake against trend change, one point per week (D166).
 *
 * The synthetic body below loses and gains exactly what 7700 kcal per kg says,
 * from a known maintenance figure. What these tests claim is what a probe of
 * that body showed, and no more:
 *
 * - **where intake has held steady for longer than the lag, the points land on
 *   the expected line**;
 * - **near a change in intake they do not**, with or without the lag shift,
 *   because the trend is an exponential average and smears a week's change
 *   across the next ten days. The shift roughly halves the miss in the weeks
 *   after a change and makes the week before the next change worse. Both halves
 *   are pinned, so nobody later reads the first test as a claim about every
 *   week.
 */

/** 2026-06-01 is a Monday. */
const MONDAY = "2026-06-01";
const MAINTENANCE = 2500;

/**
 * A person whose body obeys the arithmetic, day by day: each day's weight is
 * the previous day's plus that day's surplus over 7700, weighed on the days
 * `weighs` allows. Intake is constant within a week.
 */
function synthetic(options: {
  weeklyIntake: number[];
  weighs?: (dayIndex: number) => boolean;
  logs?: (dayIndex: number) => boolean;
  trailingDays?: number;
}) {
  const weighs = options.weighs ?? (() => true);
  const logs = options.logs ?? (() => true);
  const days = options.weeklyIntake.length * 7 + (options.trailingDays ?? 21);

  const readings: { localDate: string; weightKg: number }[] = [];
  const intake = new Map<string, number>();
  let weight = 90;

  for (let i = 0; i < days; i += 1) {
    const localDate = addDays(MONDAY, i);
    const week = Math.min(Math.floor(i / 7), options.weeklyIntake.length - 1);
    const kcal = options.weeklyIntake[week]!;
    if (weighs(i)) readings.push({ localDate, weightKg: weight });
    if (i < options.weeklyIntake.length * 7 && logs(i)) intake.set(localDate, kcal);
    weight += (kcal - MAINTENANCE) / KCAL_PER_KG;
  }

  const asOf = addDays(MONDAY, days - 1);
  return { trend: computeTrend(readings, { to: asOf }), intake, asOf };
}

/** Intake held at one level for `weeks` weeks at a time. */
const levels = (weeks: number, kcal: number[]) => kcal.flatMap((level) => Array(weeks).fill(level));

const weekIndex = (point: WeekPoint) =>
  Math.round((Date.parse(point.weekStart) - Date.parse(MONDAY)) / (7 * 86_400_000));

const offLine = (point: WeekPoint) =>
  Math.abs(point.trendChangeKgPerWeek - expectedChangeKgPerWeek(point.meanIntakeKcal, MAINTENANCE));

describe("intake against trend change, per week", () => {
  it("lands on the expected line where intake has held steady for longer than the lag", () => {
    const { trend, intake, asOf } = synthetic({ weeklyIntake: levels(6, [2000, 2900, 2300, 2700]) });
    const result = weeklyIntakeAgainstTrend({ trend, intake, asOf });

    expect(result.lagDays).toBe(9);

    // Weeks 2 and 3 of each six-week level: settled since the change, and their
    // shifted span ends before the next one.
    const settled = result.points.filter((point) => [2, 3].includes(weekIndex(point) % 6));
    expect(settled).toHaveLength(8);

    for (const point of settled) {
      expect(
        offLine(point),
        `week of ${point.weekStart}: ${point.trendChangeKgPerWeek} against ${expectedChangeKgPerWeek(point.meanIntakeKcal, MAINTENANCE)}`,
      ).toBeLessThan(0.08);
    }
  });

  describe("near a change in intake, which the shift helps and does not solve", () => {
    const { trend, intake, asOf } = synthetic({ weeklyIntake: levels(4, [2000, 2900, 2300, 2700]) });
    const shifted = weeklyIntakeAgainstTrend({ trend, intake, asOf });
    const unshifted = weeklyIntakeAgainstTrend({ trend, intake, asOf, lagDays: 0 });

    const at = (points: WeekPoint[], index: number) =>
      points.find((point) => weekIndex(point) === index)!;

    it("roughly halves the miss in the weeks right after a change", () => {
      for (const index of [4, 5, 8, 9]) {
        expect(offLine(at(shifted.points, index))).toBeLessThan(offLine(at(unshifted.points, index)) * 0.7);
      }
    });

    it("still misses by more than a settled week does, right after a change", () => {
      expect(offLine(at(shifted.points, 4))).toBeGreaterThan(0.1);
    });

    /**
     * The cost, pinned so it cannot be mistaken for a bug later: the shifted span
     * of the last week before a change reaches into the next level.
     */
    it("makes the week before the next change worse, because its span reaches into it", () => {
      for (const index of [3, 7]) {
        expect(offLine(at(shifted.points, index))).toBeGreaterThan(offLine(at(unshifted.points, index)));
      }
    });
  });

  it("puts one point on each Monday-to-Sunday week, and no week in progress", () => {
    const { trend, intake, asOf } = synthetic({ weeklyIntake: levels(4, [2000, 2900]) });
    const { points } = weeklyIntakeAgainstTrend({ trend, intake, asOf });

    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(new Date(`${point.weekStart}T12:00:00Z`).getUTCDay()).toBe(1);
      expect(point.weekEnd).toBe(addDays(point.weekStart, 6));
      expect(point.weekEnd < asOf).toBe(true);
    }
    expect(new Set(points.map((point) => point.weekStart)).size).toBe(points.length);
  });

  it("takes the mean over the logged days, and drops a week under §4.2's coverage", () => {
    // Week 0 logs six days, week 1 logs only five, every other week logs all seven.
    const { trend, intake, asOf } = synthetic({
      weeklyIntake: levels(4, [2000, 2900]),
      logs: (i) => !(i === 3 || i === 8 || i === 9),
    });
    const result = weeklyIntakeAgainstTrend({ trend, intake, asOf });

    expect(MIN_LOGGED_DAYS_PER_WEEK).toBe(6);
    const first = result.points.find((point) => point.weekStart === MONDAY)!;
    expect(first.daysLogged).toBe(6);
    expect(first.meanIntakeKcal).toBe(2000);
    expect(result.points.some((point) => point.weekStart === addDays(MONDAY, 7))).toBe(false);
    expect(result.droppedWeeks).toBeGreaterThanOrEqual(1);
  });

  it("has fewer than the minimum after three whole weeks, which the screen shows as not yet", () => {
    const { trend, intake, asOf } = synthetic({ weeklyIntake: [2400, 2400, 2400], trailingDays: 10 });
    const { points } = weeklyIntakeAgainstTrend({ trend, intake, asOf });

    expect(points.length).toBeLessThan(MIN_WHOLE_WEEKS);
  });

  it("waits for the trend to answer: a week whose shifted end is in the future has no point", () => {
    const weeklyIntake = levels(4, [2000, 2900]);
    const { trend, intake } = synthetic({ weeklyIntake, trailingDays: 21 });
    const lastWeekEnd = addDays(MONDAY, weeklyIntake.length * 7 - 1);
    // Two days after the last week ended, and its shift is nine days.
    const { points } = weeklyIntakeAgainstTrend({ trend, intake, asOf: addDays(lastWeekEnd, 2) });

    expect(points.some((point) => point.weekEnd === lastWeekEnd)).toBe(false);
  });

  it("shifts by less at a weekly weigh-in, because each update jumps further", () => {
    const { trend, intake, asOf } = synthetic({
      weeklyIntake: levels(4, [2000, 2900]),
      weighs: (i) => i % 7 === 0,
    });
    expect(weeklyIntakeAgainstTrend({ trend, intake, asOf }).lagDays).toBe(6);
  });

  it("draws nothing from nothing", () => {
    expect(weeklyIntakeAgainstTrend({ trend: [], intake: new Map(), asOf: MONDAY })).toEqual({
      points: [],
      droppedWeeks: 0,
      lagDays: 9,
    });
  });
});

describe("the expected line", () => {
  it("is seven days of surplus over 7700 kcal per kg", () => {
    expect(expectedChangeKgPerWeek(3000, 2500)).toBeCloseTo((7 * 500) / 7700, 10);
    expect(expectedChangeKgPerWeek(2500, 2500)).toBe(0);
    expect(expectedChangeKgPerWeek(2000, 2500)).toBeCloseTo(-0.4545, 3);
  });
});
