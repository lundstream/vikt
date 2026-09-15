import type { DayTableResponse } from "shared";
import { buildDayTable, toNumber, toNumberOrNull, type DayTableDaily } from "shared";
import type { Db } from "../db/index.js";
import { listActivities, listDailyLogs, listMeasurements } from "../repositories/daily.repo.js";
import { findProfile } from "../repositories/users.repo.js";
import { notFound } from "../lib/errors.js";
import { resolveIntake, resolveMacros } from "./intake.service.js";
import { resolveTrend } from "./series.service.js";

/**
 * The day table's rows (D167).
 *
 * Fetches through the owners of each series (D44, D47) and hands everything to
 * `buildDayTable`, which is where every figure is computed. Intake and the
 * trend are read whole rather than over the range, because a day's maintenance
 * reads the 28 days before it, and the first row of a range would otherwise be
 * computed from a window the query cut in half.
 */
export async function getDayTable(
  userId: string,
  db: Db,
  range: { from?: string; to: string },
): Promise<DayTableResponse> {
  const profileRow = await findProfile(userId, db);
  if (!profileRow) throw notFound("This account has no profile row.");

  const [trend, intake, dailyRows, activityRows, measurementRows] = await Promise.all([
    resolveTrend(userId, db, range.to),
    resolveIntake(userId, db, {}),
    listDailyLogs(userId, db, { to: range.to }),
    listActivities(userId, db, { to: range.to }),
    listMeasurements(userId, db, { to: range.to }),
  ]);

  /**
   * The first day anything was logged, when no start was asked for. The trend
   * begins at the first reading, and the other series are checked too, so an
   * account that logged food before it ever weighed in still gets those days.
   */
  const earliest = [
    trend[0]?.localDate,
    [...intake.keys()].sort()[0],
    dailyRows[0]?.localDate,
    activityRows.map((row) => row.localDate).sort()[0],
    measurementRows.map((row) => row.localDate).sort()[0],
  ]
    .filter((day): day is string => day !== undefined && day <= range.to)
    .sort()[0];

  const from = range.from ?? earliest ?? range.to;
  const macroDays = await resolveMacros(userId, db, { from, to: range.to });

  const daily = new Map<string, DayTableDaily>(
    dailyRows.map((row) => [
      row.localDate,
      {
        alcoholUnits: toNumberOrNull(row.alcoholUnits),
        steps: row.steps,
        sleepHours: toNumberOrNull(row.sleepHours),
        energy: row.energy,
        mood: row.mood,
      },
    ]),
  );

  /** Several sessions on a day is normal, so the day's minutes are their sum. */
  const activityMinutes = new Map<string, number>();
  for (const row of activityRows) {
    activityMinutes.set(row.localDate, (activityMinutes.get(row.localDate) ?? 0) + row.durationMin);
  }

  const waistCm = new Map(
    measurementRows
      .filter((row) => row.waistCm !== null)
      .map((row) => [row.localDate, toNumber(row.waistCm!)] as const),
  );

  return {
    from,
    to: range.to,
    rows: buildDayTable({
      from,
      to: range.to,
      trend,
      intake,
      macroDays,
      daily,
      activityMinutes,
      waistCm,
      profile: {
        sex: profileRow.sex,
        birthDate: profileRow.birthDate,
        heightCm: toNumberOrNull(profileRow.heightCm),
        activityFactor: toNumber(profileRow.activityFactor),
      },
    }),
  };
}
