import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { habitChecks, habits } from "../db/schema.js";

/**
 * `habits` and `habit_checks` (D137).
 *
 * Every function takes `userId` first and puts it in the WHERE, including the
 * ones keyed by a primary key that is already unique. A habit name is health
 * data (D107), so reading somebody else's by id is exactly the bug class §3
 * exists to prevent, and the lint rule holds the shape.
 */

export type HabitRow = typeof habits.$inferSelect;
export type HabitCheckRow = typeof habitChecks.$inferSelect;

/** The checklist: live habits only, in the order the user put them in. */
export async function listHabits(userId: string, db: Db): Promise<HabitRow[]> {
  return db
    .select()
    .from(habits)
    .where(and(eq(habits.userId, userId), isNull(habits.archivedAt)))
    .orderBy(asc(habits.sortOrder), asc(habits.createdAt));
}

/** Including archived ones, for the export: history names a habit that is gone. */
export async function listAllHabits(userId: string, db: Db): Promise<HabitRow[]> {
  return db
    .select()
    .from(habits)
    .where(eq(habits.userId, userId))
    .orderBy(asc(habits.sortOrder), asc(habits.createdAt));
}

export async function findHabit(
  userId: string,
  db: Db,
  id: string,
): Promise<HabitRow | null> {
  const [row] = await db
    .select()
    .from(habits)
    .where(and(eq(habits.userId, userId), eq(habits.id, id)))
    .limit(1);
  return row ?? null;
}

export type HabitInsert = {
  name: string;
  icon: string | null;
  sortOrder: number;
  /** The reminder, which may now be set as the habit is created (D142). */
  remind?: boolean;
  remindMinute?: number;
  remindWeekend?: boolean;
  remindWeekendMinute?: number;
};

export async function insertHabit(
  userId: string,
  db: Db,
  values: HabitInsert,
): Promise<HabitRow> {
  const [row] = await db
    .insert(habits)
    .values({ userId, ...values })
    .returning();
  return row!;
}

export type HabitPatch = Partial<{
  name: string;
  icon: string | null;
  sortOrder: number;
  remind: boolean;
  remindMinute: number;
  remindWeekend: boolean;
  remindWeekendMinute: number;
}>;

export async function updateHabit(
  userId: string,
  db: Db,
  id: string,
  patch: HabitPatch,
): Promise<HabitRow | null> {
  if (Object.keys(patch).length === 0) return findHabit(userId, db, id);

  const [row] = await db
    .update(habits)
    .set(patch)
    .where(and(eq(habits.userId, userId), eq(habits.id, id)))
    .returning();
  return row ?? null;
}

/**
 * Takes a habit off the checklist and keeps its history.
 *
 * The row survives because the checks name it: a tick whose habit has been
 * deleted outright is a date with nothing attached, and the export would have
 * to invent a word for it.
 */
export async function archiveHabit(
  userId: string,
  db: Db,
  id: string,
): Promise<HabitRow | null> {
  const [row] = await db
    .update(habits)
    .set({ archivedAt: new Date() })
    .where(and(eq(habits.userId, userId), eq(habits.id, id)))
    .returning();
  return row ?? null;
}

/** The real delete. The checks go with it, by cascade. */
export async function deleteHabit(userId: string, db: Db, id: string): Promise<boolean> {
  const removed = await db
    .delete(habits)
    .where(and(eq(habits.userId, userId), eq(habits.id, id)))
    .returning({ id: habits.id });
  return removed.length > 0;
}

/** Writes a whole order in one statement, so a move cannot half-apply. */
export async function setHabitOrder(
  userId: string,
  db: Db,
  ids: readonly string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx
        .update(habits)
        .set({ sortOrder: index })
        .where(and(eq(habits.userId, userId), eq(habits.id, id)));
    }
  });
}

/* --------------------------------------------------------------- the ticks */

export type HabitCheckInsert = {
  habitId: string;
  clientUuid: string;
  localDate: string;
  checked: boolean;
};

/**
 * Idempotent on `(user_id, habit_id, local_date)`.
 *
 * The day is the identity here, not the `client_uuid`: two taps on one day are
 * one answer that changed its mind, not two rows. The `client_uuid` still rides
 * along so the queue's replay of the same tap is a no-op rather than a second
 * write, and so a replayed row can be traced back to the tap that made it.
 */
export async function upsertHabitCheck(
  userId: string,
  db: Db,
  values: HabitCheckInsert,
): Promise<HabitCheckRow> {
  const [row] = await db
    .insert(habitChecks)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [habitChecks.userId, habitChecks.habitId, habitChecks.localDate],
      set: {
        checked: values.checked,
        clientUuid: values.clientUuid,
        loggedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/** Every check for one habit. Bounded by days, and read to build a streak. */
export async function listChecksForHabit(
  userId: string,
  db: Db,
  habitId: string,
): Promise<HabitCheckRow[]> {
  return db
    .select()
    .from(habitChecks)
    .where(and(eq(habitChecks.userId, userId), eq(habitChecks.habitId, habitId)))
    .orderBy(asc(habitChecks.localDate));
}

/** Every check this account has, for the day screen and the export. */
export async function listChecks(userId: string, db: Db): Promise<HabitCheckRow[]> {
  return db
    .select()
    .from(habitChecks)
    .where(eq(habitChecks.userId, userId))
    .orderBy(asc(habitChecks.localDate));
}

/** Whether a habit is ticked on a given day, for the reminder's skip rule. */
export async function isHabitCheckedOn(
  userId: string,
  db: Db,
  habitId: string,
  localDate: string,
): Promise<boolean> {
  const [row] = await db
    .select({ checked: habitChecks.checked })
    .from(habitChecks)
    .where(
      and(
        eq(habitChecks.userId, userId),
        eq(habitChecks.habitId, habitId),
        eq(habitChecks.localDate, localDate),
      ),
    )
    .limit(1);
  return row?.checked === true;
}

/** How many habits the checklist holds, for the limit. */
export async function countHabits(userId: string, db: Db): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(habits)
    .where(and(eq(habits.userId, userId), isNull(habits.archivedAt)));
  return row?.count ?? 0;
}
