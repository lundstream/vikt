/**
 * One row per day, every figure the app keeps about it (D167).
 *
 * The Data screen's table and the first sheet of the Excel export are the same
 * rows from this function, so the two cannot disagree about a day. Nothing here
 * is a new formula: the trend is §4.1's, the macros and their "minst" are
 * `dayMacros` (D55), and maintenance **as of each day** is `estimateTdee` run
 * with that day as `asOf`, which is exactly what the dashboard showed on that
 * day, source and all.
 *
 * Absent is not zero (D44), in every column: a day with no reading has no
 * weight, a day with nothing logged has no intake, and a difference needs both
 * of its halves.
 *
 * Pure. No I/O, no clock.
 */
import { intakeOn, type IntakeIndex } from "./intake.js";
import { dayMacros, type MacroEntry } from "./macros.js";
import { estimateTdee, type TdeeProfile } from "./tdee.js";
import { eachDay, type TrendPoint } from "./trend.js";

export type DayTableMacro = {
  /** The day's known grams, or null when no logged food carries the macro. */
  grams: number | null;
  /** False below D55's gate, which the table shows as "minst". */
  complete: boolean;
};

export type DayTableRow = {
  localDate: string;
  /** The reading that day, never the carried trend. */
  weightKg: number | null;
  /** §4.1's trend on that day, carried forward on a day without a reading. */
  trendKg: number | null;
  /** The day's intake as §4.2 reads it. */
  intakeKcal: number | null;
  /**
   * 0 to 1 of the day's logged energy that came from entries carrying any macro
   * at all. Null when nothing was logged.
   */
  intakeCoverage: number | null;
  protein: DayTableMacro;
  carbs: DayTableMacro;
  fat: DayTableMacro;
  fiber: DayTableMacro;
  alcoholUnits: number | null;
  activityMinutes: number | null;
  steps: number | null;
  sleepHours: number | null;
  energy: number | null;
  mood: number | null;
  waistCm: number | null;
  /** Maintenance as the dashboard would have shown it on this day. */
  maintenanceKcal: number | null;
  /** `adaptive` is measured from the person's own data; `formula` is Mifflin-St Jeor. */
  maintenanceSource: "adaptive" | "formula" | null;
  /** Intake minus that day's maintenance, when both exist. */
  intakeMinusMaintenanceKcal: number | null;
};

export type DayTableDaily = {
  alcoholUnits: number | null;
  steps: number | null;
  sleepHours: number | null;
  energy: number | null;
  mood: number | null;
};

export type DayTableInput = {
  from: string;
  to: string;
  /** From `computeTrend`, extended to `to`. The whole history, not only the range. */
  trend: readonly TrendPoint[];
  /** The whole history, because maintenance reads the 28 days before each row. */
  intake: IntakeIndex;
  macroDays: ReadonlyMap<string, readonly MacroEntry[]>;
  daily: ReadonlyMap<string, DayTableDaily>;
  activityMinutes: ReadonlyMap<string, number>;
  waistCm: ReadonlyMap<string, number>;
  profile: TdeeProfile;
};

const EMPTY: DayTableMacro = { grams: null, complete: false };

export function buildDayTable(input: DayTableInput): DayTableRow[] {
  if (input.from > input.to) return [];

  const trendByDay = new Map(input.trend.map((point) => [point.localDate, point]));
  const rows: DayTableRow[] = [];

  for (const localDate of eachDay(input.from, input.to)) {
    const point = trendByDay.get(localDate);
    const entries = input.macroDays.get(localDate) ?? [];
    const macros = entries.length === 0 ? null : dayMacros(entries);
    const daily = input.daily.get(localDate);
    const intakeKcal = intakeOn(input.intake, localDate);

    const energy = entries.reduce((sum, entry) => sum + Math.max(0, entry.kcal), 0);
    const labelled = entries
      .filter(
        (entry) =>
          entry.proteinG !== null ||
          entry.carbsG !== null ||
          entry.fatG !== null ||
          entry.fiberG !== null,
      )
      .reduce((sum, entry) => sum + Math.max(0, entry.kcal), 0);

    const maintenance = estimateTdee({
      trend: input.trend,
      intake: input.intake,
      asOf: localDate,
      profile: input.profile,
    });
    const maintenanceKcal =
      maintenance.source === "none" || maintenance.tdee === null ? null : maintenance.tdee;

    rows.push({
      localDate,
      weightKg: point?.raw ?? null,
      trendKg: point?.trend ?? null,
      intakeKcal,
      intakeCoverage: entries.length === 0 ? null : energy > 0 ? labelled / energy : 0,
      protein: macros ? { grams: macros.protein.grams, complete: macros.protein.complete } : EMPTY,
      carbs: macros ? { grams: macros.carbs.grams, complete: macros.carbs.complete } : EMPTY,
      fat: macros ? { grams: macros.fat.grams, complete: macros.fat.complete } : EMPTY,
      fiber: macros ? { grams: macros.fiber.grams, complete: macros.fiber.complete } : EMPTY,
      alcoholUnits: daily?.alcoholUnits ?? null,
      activityMinutes: input.activityMinutes.get(localDate) ?? null,
      steps: daily?.steps ?? null,
      sleepHours: daily?.sleepHours ?? null,
      energy: daily?.energy ?? null,
      mood: daily?.mood ?? null,
      waistCm: input.waistCm.get(localDate) ?? null,
      maintenanceKcal,
      maintenanceSource:
        maintenanceKcal === null ? null : (maintenance.source as "adaptive" | "formula"),
      intakeMinusMaintenanceKcal:
        intakeKcal === null || maintenanceKcal === null ? null : intakeKcal - maintenanceKcal,
    });
  }

  return rows;
}
