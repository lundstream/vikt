import type {
  ActivityEntry,
  CreateActivity,
  CreateDailyLog,
  CreateMeasurement,
  DailyLogEntry,
  DateRangeQuery,
  DayLog,
  MeasurementEntry,
} from "shared";
import {
  activityKcal,
  metFor,
  toNumber,
  toNumberOrNull,
  toNumeric,
  toNumericOrNull,
} from "shared";
import type { Db } from "../db/index.js";
import {
  deleteActivity,
  deleteDailyForDayExcept,
  deleteDailyLog,
  deleteMeasurementForDayExcept,
  findDailyForDay,
  findMeasurementForDay,
  listActivities,
  listDailyLogs,
  listMeasurements,
  upsertActivityByClientUuid,
  upsertDailyByClientUuid,
  upsertMeasurementByClientUuid,
  type ActivityRow,
  type DailyRow,
  type MeasurementRow,
} from "../repositories/daily.repo.js";
import { getWeightRows } from "./series.service.js";
import { notFound } from "../lib/errors.js";
import { detectMilestones, getOffsetsForDay, getRulesForDay } from "./progress.service.js";

/**
 * Measurements, the daily log and activity.
 *
 * `userId` first, always (CLAUDE.md §3). `localDate` comes from the client and
 * is written through untouched. Every writable field is optional: a day where
 * someone rated their energy and nothing else is a real day.
 */

/* ------------------------------------------------------------ measurements */

function toMeasurement(row: MeasurementRow): MeasurementEntry {
  return {
    id: row.id,
    clientUuid: row.clientUuid,
    localDate: row.localDate,
    loggedAt: row.loggedAt.toISOString(),
    waistCm: toNumberOrNull(row.waistCm),
    chestCm: toNumberOrNull(row.chestCm),
    neckCm: toNumberOrNull(row.neckCm),
    hipsCm: toNumberOrNull(row.hipsCm),
    thighCm: toNumberOrNull(row.thighCm),
    armCm: toNumberOrNull(row.armCm),
    note: row.note,
  };
}

/**
 * One canonical measurement per day, replaced by a later one — the same shape
 * as weight, and for the same reason: two tape readings on one afternoon are
 * one measurement taken twice, not two data points.
 */
export async function saveMeasurement(
  userId: string,
  db: Db,
  input: CreateMeasurement,
): Promise<MeasurementEntry> {
  const row = await db.transaction(async (tx) => {
    await deleteMeasurementForDayExcept(userId, tx, input.localDate, input.clientUuid);

    return upsertMeasurementByClientUuid(userId, tx, {
      clientUuid: input.clientUuid,
      localDate: input.localDate,
      loggedAt: new Date(),
      waistCm: toNumericOrNull(input.waistCm, 1),
      chestCm: toNumericOrNull(input.chestCm, 1),
      neckCm: toNumericOrNull(input.neckCm, 1),
      hipsCm: toNumericOrNull(input.hipsCm, 1),
      thighCm: toNumericOrNull(input.thighCm, 1),
      armCm: toNumericOrNull(input.armCm, 1),
      note: input.note ?? null,
    });
  });

  // A waist reading moves both the waist and the waist-to-height metrics, so
  // detection runs here too, against the smoothed series rather than the tape
  // reading (D32: a hand-held tape carries about a centimetre either way).
  await detectMilestones(userId, db, input.localDate);

  return toMeasurement(row);
}

export async function getMeasurements(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<MeasurementEntry[]> {
  const rows = await listMeasurements(userId, db, range);
  return rows.map(toMeasurement);
}

/* -------------------------------------------------------------- daily log */

function toDaily(row: DailyRow): DailyLogEntry {
  return {
    id: row.id,
    clientUuid: row.clientUuid,
    localDate: row.localDate,
    loggedAt: row.loggedAt.toISOString(),
    sweat: row.sweat,
    energy: row.energy,
    mood: row.mood,
    hunger: row.hunger,
    sleepHours: toNumberOrNull(row.sleepHours),
    steps: row.steps,
    alcoholUnits: toNumberOrNull(row.alcoholUnits),
    note: row.note,
  };
}

export async function saveDailyLog(
  userId: string,
  db: Db,
  input: CreateDailyLog,
): Promise<DailyLogEntry> {
  const row = await db.transaction(async (tx) => {
    await deleteDailyForDayExcept(userId, tx, input.localDate, input.clientUuid);

    return upsertDailyByClientUuid(userId, tx, {
      clientUuid: input.clientUuid,
      localDate: input.localDate,
      loggedAt: new Date(),
      sweat: input.sweat ?? null,
      energy: input.energy ?? null,
      mood: input.mood ?? null,
      hunger: input.hunger ?? null,
      sleepHours: toNumericOrNull(input.sleepHours, 1),
      steps: input.steps ?? null,
      alcoholUnits: toNumericOrNull(input.alcoholUnits, 1),
      note: input.note ?? null,
    });
  });

  // The daily row moves the logging streak and the sober counter, both of
  // which are milestone metrics.
  await detectMilestones(userId, db, input.localDate);

  return toDaily(row);
}

/** Removes a whole day's ratings. The day becomes unlogged, not zeroed. */
export async function removeDailyLog(userId: string, db: Db, id: string): Promise<void> {
  if (!(await deleteDailyLog(userId, db, id))) {
    throw notFound("Det finns ingen sådan dagsnotering.");
  }
}

export async function getDailyLogs(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<DailyLogEntry[]> {
  const rows = await listDailyLogs(userId, db, range);
  return rows.map(toDaily);
}

/* --------------------------------------------------------------- activity */

function toActivity(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    clientUuid: row.clientUuid,
    localDate: row.localDate,
    loggedAt: row.loggedAt.toISOString(),
    activityType: row.activityType,
    durationMin: row.durationMin,
    intensity: row.intensity,
    metValue: toNumberOrNull(row.metValue),
    kcalEstimate: row.kcalEstimate,
    note: row.note,
  };
}

/**
 * The most recent weight reading at or before a day, for the MET estimate.
 *
 * The raw reading rather than the trend: this is a rough estimate either way
 * (D33), and reaching for the smoothed series here would imply a precision the
 * MET table does not have.
 */
async function weightForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<number | null> {
  const rows = await getWeightRows(userId, db, { to: localDate });
  const last = rows.at(-1);
  return last ? toNumber(last.weightKg) : null;
}

/**
 * The kcal figure is computed **here**, from the MET table and the body weight
 * the server already holds — never accepted from the client. Two devices would
 * otherwise disagree, and a number the client can set is a number that can be
 * set to anything.
 *
 * It is stored as an estimate and read by nothing that computes maintenance or
 * a projection (D33).
 */
export async function saveActivity(
  userId: string,
  db: Db,
  input: CreateActivity,
): Promise<ActivityEntry> {
  const weightKg = await weightForDay(userId, db, input.localDate);
  const met = metFor(input.activityType, input.intensity);

  const row = await upsertActivityByClientUuid(userId, db, {
    clientUuid: input.clientUuid,
    localDate: input.localDate,
    loggedAt: new Date(),
    activityType: input.activityType,
    durationMin: input.durationMin,
    intensity: input.intensity ?? null,
    metValue: toNumeric(met, 2),
    kcalEstimate: activityKcal({
      type: input.activityType,
      durationMin: input.durationMin,
      intensity: input.intensity,
      weightKg,
    }),
    note: input.note ?? null,
  });

  return toActivity(row);
}

export async function getActivities(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<ActivityEntry[]> {
  const rows = await listActivities(userId, db, range);
  return rows.map(toActivity);
}

export async function removeActivity(userId: string, db: Db, id: string): Promise<void> {
  const deleted = await deleteActivity(userId, db, id);
  if (!deleted) throw notFound("There is no such activity.");
}

/* ------------------------------------------------- the whole day, at once */

/**
 * Everything already logged for one day, in one request.
 *
 * Logging a day is mostly *amending* it — sleep in the morning, energy at
 * night — so the screen has to open filled in. A blank form on the second visit
 * means retyping what is already there, or losing it.
 */
export async function getDayLog(userId: string, db: Db, localDate: string): Promise<DayLog> {
  const [daily, measurement, activities, weights, savingsRules, offsets] =
    await Promise.all([
      findDailyForDay(userId, db, localDate),
      findMeasurementForDay(userId, db, localDate),
      listActivities(userId, db, { from: localDate, to: localDate }),
      getWeightRows(userId, db, { from: localDate, to: localDate }),
      getRulesForDay(userId, db, localDate),
      getOffsetsForDay(userId, db, localDate),
    ]);

  const weight = weights.at(-1);
  const offsetRuleIds = new Set(offsets.map((offset) => offset.ruleId));

  return {
    localDate,
    daily: daily ? toDaily(daily) : null,
    measurement: measurement ? toMeasurement(measurement) : null,
    activities: activities.map(toActivity),
    weightKg: weight ? toNumber(weight.weightKg) : null,
    /**
     * The savings rules that accrued today, each flagged with whether an offset
     * has already been filed (D37). They ride along with the day rather than
     * living on their own screen, because an offset nobody enters makes the pot
     * fiction, and a separate flow is one nobody visits.
     */
    savingsRules: savingsRules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      amountSek: rule.amountSek,
      offsetToday: offsetRuleIds.has(rule.id),
    })),
  };
}
