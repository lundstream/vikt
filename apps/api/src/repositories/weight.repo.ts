import { and, asc, eq, gte, lte, ne, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { weightLog } from "../db/schema.js";

export type WeightRow = typeof weightLog.$inferSelect;

/**
 * `weight_log`. Every function takes `userId` first and puts it in the WHERE,
 * including the ones where another column is already unique — that is what
 * turns an IDOR into a miss rather than a leak (CLAUDE.md §3).
 */

export type WeightInsert = {
  clientUuid: string;
  localDate: string;
  loggedAt: Date;
  weightKg: string;
  bodyFatPct: string | null;
  source: string;
  note: string | null;
};

/**
 * Idempotent upsert (CLAUDE.md §3). The offline queue replays on reconnect and
 * replays are expected, so a repeat of the same `client_uuid` updates the row
 * rather than erroring or duplicating.
 *
 * There is a second unique index on `(user_id, local_date)`: one canonical
 * reading per day, a later reading replaces it. Two different `client_uuid`s on
 * the same day would collide on it, so the day row is cleared first — see
 * `upsertWeightEntry` in the service, which does both inside one transaction.
 */
export async function upsertWeightByClientUuid(
  userId: string,
  db: Db,
  values: WeightInsert,
): Promise<WeightRow> {
  const [row] = await db
    .insert(weightLog)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [weightLog.userId, weightLog.clientUuid],
      set: {
        localDate: values.localDate,
        loggedAt: values.loggedAt,
        weightKg: values.weightKg,
        bodyFatPct: values.bodyFatPct,
        source: values.source,
        note: values.note,
      },
    })
    .returning();

  if (!row) throw new Error("upsertWeightByClientUuid returned no row");
  return row;
}

/**
 * Removes any other entry already occupying that day for this user, so the
 * `(user_id, local_date)` index cannot reject the upsert. Scoped by user id, so
 * it can never touch anyone else's day.
 */
export async function deleteWeightForDayExcept(
  userId: string,
  db: Db,
  localDate: string,
  keepClientUuid: string,
): Promise<void> {
  await db
    .delete(weightLog)
    .where(
      and(
        eq(weightLog.userId, userId),
        eq(weightLog.localDate, localDate),
        ne(weightLog.clientUuid, keepClientUuid),
      ),
    );
}

/**
 * Removes one reading. Scoped by user id as well as by row id, so a guessed
 * uuid deletes nothing rather than someone else's morning (§3).
 *
 * Returns whether a row went, so the route can answer 404 rather than
 * pretending a deletion happened.
 */
export async function deleteWeightEntry(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(weightLog)
    .where(and(eq(weightLog.userId, userId), eq(weightLog.id, id)))
    .returning({ id: weightLog.id });

  return rows.length > 0;
}

/** The reading already occupying a day, if any. Scoped by user, like all of these. */
export async function findWeightForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<WeightRow | null> {
  const [row] = await db
    .select()
    .from(weightLog)
    .where(and(eq(weightLog.userId, userId), eq(weightLog.localDate, localDate)))
    .limit(1);

  return row ?? null;
}

/** One reading by its own id, scoped by user like everything else (§3). */
export async function findWeightById(
  userId: string,
  db: Db,
  id: string,
): Promise<WeightRow | null> {
  const [row] = await db
    .select()
    .from(weightLog)
    .where(and(eq(weightLog.userId, userId), eq(weightLog.id, id)))
    .limit(1);

  return row ?? null;
}

/** Changes a row in place, by id. Returns the row as it now stands. */
export async function updateWeightRow(
  userId: string,
  db: Db,
  id: string,
  values: {
    localDate: string;
    weightKg: string;
    bodyFatPct: string | null;
    note: string | null;
    loggedAt: Date;
  },
): Promise<WeightRow | null> {
  const [row] = await db
    .update(weightLog)
    .set(values)
    .where(and(eq(weightLog.userId, userId), eq(weightLog.id, id)))
    .returning();

  return row ?? null;
}

export async function listWeightEntries(
  userId: string,
  db: Db,
  range: { from?: string | undefined; to?: string | undefined } = {},
): Promise<WeightRow[]> {
  const filters: SQL[] = [eq(weightLog.userId, userId)];
  if (range.from) filters.push(gte(weightLog.localDate, range.from));
  if (range.to) filters.push(lte(weightLog.localDate, range.to));

  return db
    .select()
    .from(weightLog)
    .where(and(...filters))
    .orderBy(asc(weightLog.localDate));
}
