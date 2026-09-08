import { and, asc, eq, gte, lte, ne, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { activityLog, dailyLog, measurementLog } from "../db/schema.js";

/**
 * `measurement_log`, `daily_log` and `activity_log`.
 *
 * Every function takes `userId` first and puts it in the WHERE, including the
 * ones where `client_uuid` is already unique. That is what turns an IDOR into a
 * miss rather than a leak (CLAUDE.md §3), and the lint rule in
 * `eslint-rules/user-id-first-param.js` enforces the shape.
 */

export type MeasurementRow = typeof measurementLog.$inferSelect;
export type DailyRow = typeof dailyLog.$inferSelect;
export type ActivityRow = typeof activityLog.$inferSelect;

type Range = { from?: string | undefined; to?: string | undefined };

/* ------------------------------------------------------------ measurements */

export type MeasurementInsert = {
  clientUuid: string;
  localDate: string;
  loggedAt: Date;
  waistCm: string | null;
  chestCm: string | null;
  neckCm: string | null;
  hipsCm: string | null;
  thighCm: string | null;
  armCm: string | null;
  note: string | null;
};

/**
 * Idempotent upsert on `(user_id, client_uuid)`. A second measurement on a day
 * replaces the first, same as weight — the `(user_id, local_date)` index says
 * so — which `deleteMeasurementForDayExcept` makes room for.
 */
export async function upsertMeasurementByClientUuid(
  userId: string,
  db: Db,
  values: MeasurementInsert,
): Promise<MeasurementRow> {
  const [row] = await db
    .insert(measurementLog)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [measurementLog.userId, measurementLog.clientUuid],
      set: {
        localDate: values.localDate,
        loggedAt: values.loggedAt,
        waistCm: values.waistCm,
        chestCm: values.chestCm,
        neckCm: values.neckCm,
        hipsCm: values.hipsCm,
        thighCm: values.thighCm,
        armCm: values.armCm,
        note: values.note,
      },
    })
    .returning();

  if (!row) throw new Error("upsertMeasurementByClientUuid returned no row");
  return row;
}

export async function deleteMeasurementForDayExcept(
  userId: string,
  db: Db,
  localDate: string,
  keepClientUuid: string,
): Promise<void> {
  await db
    .delete(measurementLog)
    .where(
      and(
        eq(measurementLog.userId, userId),
        eq(measurementLog.localDate, localDate),
        ne(measurementLog.clientUuid, keepClientUuid),
      ),
    );
}

export async function listMeasurements(
  userId: string,
  db: Db,
  range: Range = {},
): Promise<MeasurementRow[]> {
  const filters: SQL[] = [eq(measurementLog.userId, userId)];
  if (range.from) filters.push(gte(measurementLog.localDate, range.from));
  if (range.to) filters.push(lte(measurementLog.localDate, range.to));

  return db
    .select()
    .from(measurementLog)
    .where(and(...filters))
    .orderBy(asc(measurementLog.localDate));
}

export async function findMeasurementForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<MeasurementRow | null> {
  const [row] = await db
    .select()
    .from(measurementLog)
    .where(and(eq(measurementLog.userId, userId), eq(measurementLog.localDate, localDate)))
    .limit(1);

  return row ?? null;
}

/* -------------------------------------------------------------- daily log */

export type DailyInsert = {
  clientUuid: string;
  localDate: string;
  loggedAt: Date;
  sweat: number | null;
  energy: number | null;
  mood: number | null;
  hunger: number | null;
  sleepHours: string | null;
  steps: number | null;
  alcoholUnits: string | null;
  note: string | null;
};

export async function upsertDailyByClientUuid(
  userId: string,
  db: Db,
  values: DailyInsert,
): Promise<DailyRow> {
  const [row] = await db
    .insert(dailyLog)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [dailyLog.userId, dailyLog.clientUuid],
      set: {
        localDate: values.localDate,
        loggedAt: values.loggedAt,
        sweat: values.sweat,
        energy: values.energy,
        mood: values.mood,
        hunger: values.hunger,
        sleepHours: values.sleepHours,
        steps: values.steps,
        alcoholUnits: values.alcoholUnits,
        note: values.note,
      },
    })
    .returning();

  if (!row) throw new Error("upsertDailyByClientUuid returned no row");
  return row;
}

export async function deleteDailyForDayExcept(
  userId: string,
  db: Db,
  localDate: string,
  keepClientUuid: string,
): Promise<void> {
  await db
    .delete(dailyLog)
    .where(
      and(
        eq(dailyLog.userId, userId),
        eq(dailyLog.localDate, localDate),
        ne(dailyLog.clientUuid, keepClientUuid),
      ),
    );
}

/** Scoped by user id as well as row id. Returns whether a row went. */
export async function deleteDailyLog(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(dailyLog)
    .where(and(eq(dailyLog.userId, userId), eq(dailyLog.id, id)))
    .returning({ id: dailyLog.id });

  return rows.length > 0;
}

export async function listDailyLogs(
  userId: string,
  db: Db,
  range: Range = {},
): Promise<DailyRow[]> {
  const filters: SQL[] = [eq(dailyLog.userId, userId)];
  if (range.from) filters.push(gte(dailyLog.localDate, range.from));
  if (range.to) filters.push(lte(dailyLog.localDate, range.to));

  return db
    .select()
    .from(dailyLog)
    .where(and(...filters))
    .orderBy(asc(dailyLog.localDate));
}

export async function findDailyForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<DailyRow | null> {
  const [row] = await db
    .select()
    .from(dailyLog)
    .where(and(eq(dailyLog.userId, userId), eq(dailyLog.localDate, localDate)))
    .limit(1);

  return row ?? null;
}

/* --------------------------------------------------------------- activity */

export type ActivityInsert = {
  clientUuid: string;
  localDate: string;
  loggedAt: Date;
  activityType: string;
  durationMin: number;
  intensity: number | null;
  metValue: string | null;
  kcalEstimate: number | null;
  note: string | null;
};

/**
 * No one-per-day index here: three sessions in a day is normal, so uniqueness
 * is on `client_uuid` alone and a replay updates that one session.
 */
export async function upsertActivityByClientUuid(
  userId: string,
  db: Db,
  values: ActivityInsert,
): Promise<ActivityRow> {
  const [row] = await db
    .insert(activityLog)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [activityLog.userId, activityLog.clientUuid],
      set: {
        localDate: values.localDate,
        loggedAt: values.loggedAt,
        activityType: values.activityType,
        durationMin: values.durationMin,
        intensity: values.intensity,
        metValue: values.metValue,
        kcalEstimate: values.kcalEstimate,
        note: values.note,
      },
    })
    .returning();

  if (!row) throw new Error("upsertActivityByClientUuid returned no row");
  return row;
}

export async function listActivities(
  userId: string,
  db: Db,
  range: Range = {},
): Promise<ActivityRow[]> {
  const filters: SQL[] = [eq(activityLog.userId, userId)];
  if (range.from) filters.push(gte(activityLog.localDate, range.from));
  if (range.to) filters.push(lte(activityLog.localDate, range.to));

  return db
    .select()
    .from(activityLog)
    .where(and(...filters))
    .orderBy(asc(activityLog.localDate));
}

/** Scoped by user id, so it can only ever delete the caller's own session. */
export async function deleteActivity(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(activityLog)
    .where(and(eq(activityLog.userId, userId), eq(activityLog.id, id)))
    .returning({ id: activityLog.id });

  return rows.length > 0;
}
