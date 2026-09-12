import {
  habitStreak,
  HABIT_MAX,
  isHabitIcon,
  type CreateHabit,
  type CreateHabitCheck,
  type Habit,
  type HabitDay,
  type HabitStreakWire,
  type UpdateHabit,
} from "shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { reminderSends } from "../db/schema.js";
import {
  archiveHabit,
  countHabits,
  deleteHabit,
  findHabit,
  insertHabit,
  listChecks,
  listHabits,
  setHabitOrder,
  updateHabit,
  upsertHabitCheck,
  type HabitCheckRow,
  type HabitRow,
} from "../repositories/habit.repo.js";

/**
 * The habit checklist (D137).
 *
 * Three things live here rather than in the routes, because all three are
 * decisions rather than plumbing:
 *
 * **The streak is computed, never stored.** Ticks are the record; a stored
 * counter is a second copy of the same fact that can disagree with it, and the
 * first backfilled day would make it wrong forever. `habitStreak` in `calc/` is
 * the one implementation, shared with the client.
 *
 * **A day answered is not the same as a day ticked.** The "answered" set spans
 * every habit, so ticking two of three on a Tuesday makes the third habit's
 * Tuesday a *miss* rather than a day nobody was there for. That distinction is
 * the whole reason unticking writes a row.
 *
 * **Deleting keeps the history unless asked otherwise.** `keep` archives, which
 * is why the row has `archived_at`: the ticks name it, and something has to
 * keep saying what it was called.
 */

export class HabitLimitReached extends Error {
  constructor() {
    super("habit limit reached");
    this.name = "HabitLimitReached";
  }
}

function toHabit(row: HabitRow): Habit {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    remind: row.remind,
    remindMinute: row.remindMinute,
    remindWeekend: row.remindWeekend,
    remindWeekendMinute: row.remindWeekendMinute,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The two sets a streak is built from.
 *
 * Built once per request from every check the account has, rather than once per
 * habit: a checklist of ten habits over a year is a few thousand small rows,
 * and ten queries to answer one screen is the shape that gets slow quietly.
 */
function partition(checks: readonly HabitCheckRow[]) {
  const answered = new Set<string>();
  const tickedByHabit = new Map<string, Set<string>>();
  const answeredByHabit = new Map<string, Set<string>>();

  for (const check of checks) {
    answered.add(check.localDate);

    let days = answeredByHabit.get(check.habitId);
    if (days === undefined) answeredByHabit.set(check.habitId, (days = new Set()));
    days.add(check.localDate);

    if (!check.checked) continue;
    let ticked = tickedByHabit.get(check.habitId);
    if (ticked === undefined) tickedByHabit.set(check.habitId, (ticked = new Set()));
    ticked.add(check.localDate);
  }

  return { answered, tickedByHabit, answeredByHabit };
}

const EMPTY = new Set<string>();

/** The checklist as the day screen needs it: definitions plus that day's answer. */
export async function getHabitsForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<HabitDay[]> {
  const [rows, checks] = await Promise.all([listHabits(userId, db), listChecks(userId, db)]);
  if (rows.length === 0) return [];

  const { answered, tickedByHabit, answeredByHabit } = partition(checks);

  return rows.map((row) => {
    const ticked = tickedByHabit.get(row.id) ?? EMPTY;
    return {
      ...toHabit(row),
      checked: ticked.has(localDate),
      answered: (answeredByHabit.get(row.id) ?? EMPTY).has(localDate),
      /**
       * Counted to the day being **shown**, not to today. Browsing back to last
       * Tuesday and reading a streak counted to today would be a number about a
       * different day than everything else on the screen.
       */
      streak: habitStreak({ ticked, answered, asOf: localDate }),
    };
  });
}

export async function getHabits(userId: string, db: Db): Promise<Habit[]> {
  return (await listHabits(userId, db)).map(toHabit);
}

export async function createHabit(
  userId: string,
  db: Db,
  input: CreateHabit,
): Promise<Habit> {
  if ((await countHabits(userId, db)) >= HABIT_MAX) throw new HabitLimitReached();

  const existing = await listHabits(userId, db);
  const last = existing.at(-1);

  return toHabit(
    await insertHabit(userId, db, {
      name: input.name,
      icon: input.icon != null && isHabitIcon(input.icon) ? input.icon : null,
      // Appended rather than inserted at the top: a new habit joins the end of
      // a list somebody has already put in an order they meant.
      sortOrder: last === undefined ? 0 : last.sortOrder + 1,
      /**
       * The reminder arrives with the habit now (D142). Absent means off, which
       * is both the column default and the only defensible default for a
       * notification.
       */
      ...(input.remind !== undefined ? { remind: input.remind } : {}),
      ...(input.remindMinute !== undefined ? { remindMinute: input.remindMinute } : {}),
      ...(input.remindWeekend !== undefined ? { remindWeekend: input.remindWeekend } : {}),
      ...(input.remindWeekendMinute !== undefined
        ? { remindWeekendMinute: input.remindWeekendMinute }
        : {}),
    }),
  );
}

export async function editHabit(
  userId: string,
  db: Db,
  id: string,
  input: UpdateHabit,
): Promise<Habit | null> {
  const patch = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.icon !== undefined
      ? { icon: input.icon != null && isHabitIcon(input.icon) ? input.icon : null }
      : {}),
    ...(input.remind !== undefined ? { remind: input.remind } : {}),
    ...(input.remindMinute !== undefined ? { remindMinute: input.remindMinute } : {}),
    ...(input.remindWeekend !== undefined ? { remindWeekend: input.remindWeekend } : {}),
    ...(input.remindWeekendMinute !== undefined
      ? { remindWeekendMinute: input.remindWeekendMinute }
      : {}),
  };

  const row = await updateHabit(userId, db, id, patch);
  return row === null ? null : toHabit(row);
}

export async function reorderHabits(
  userId: string,
  db: Db,
  ids: readonly string[],
): Promise<Habit[]> {
  /**
   * Only ids this account owns are written, and the rest of the list is left
   * alone. An id from somewhere else is not an error worth a 404 on a reorder:
   * it is simply not this user's row, and the WHERE says so.
   */
  await setHabitOrder(userId, db, ids);
  return getHabits(userId, db);
}

/**
 * Removing a habit, with or without its history.
 *
 * `keep` archives: the checklist loses the row, the ticks stay, and the export
 * still knows what they were called. `remove` deletes for real and the checks
 * go by cascade, along with any reminder claims filed under this habit's kind,
 * which nothing else would ever collect.
 */
export async function removeHabit(
  userId: string,
  db: Db,
  id: string,
  history: "keep" | "remove",
): Promise<boolean> {
  if (history === "keep") return (await archiveHabit(userId, db, id)) !== null;

  const removed = await deleteHabit(userId, db, id);
  if (removed) await clearHabitClaims(userId, db, id);
  return removed;
}

/**
 * The claims a deleted habit's reminder left behind.
 *
 * `reminder_sends` keys on the kind rather than on a habit id (D137), which is
 * what let the existing unique index guard habit reminders without a column of
 * its own. The cost is that a hard delete has to sweep its own rows: nothing
 * cascades to a string.
 */
async function clearHabitClaims(userId: string, db: Db, habitId: string): Promise<void> {
  await db
    .delete(reminderSends)
    .where(and(eq(reminderSends.userId, userId), eq(reminderSends.kind, `habit:${habitId}`)));
}

/**
 * Ticking, or unticking, one habit on one day.
 *
 * Answers with the habit's streak as it now stands, because the screen shows it
 * next to the row and a second request to find out what the tap did is a
 * second request the offline queue cannot make.
 */
export async function saveHabitCheck(
  userId: string,
  db: Db,
  input: CreateHabitCheck,
): Promise<{ id: string; habitId: string; localDate: string; checked: boolean; streak: HabitStreakWire } | null> {
  // Scoped, and the reason this is not a plain insert: a habit id from another
  // account must be a miss, not a row.
  const habit = await findHabit(userId, db, input.habitId);
  if (habit === null || habit.archivedAt !== null) return null;

  const row = await upsertHabitCheck(userId, db, {
    habitId: input.habitId,
    clientUuid: input.clientUuid,
    localDate: input.localDate,
    checked: input.checked,
  });

  const checks = await listChecks(userId, db);
  const { answered, tickedByHabit } = partition(checks);

  return {
    id: row.id,
    habitId: row.habitId,
    localDate: row.localDate,
    checked: row.checked,
    streak: habitStreak({
      ticked: tickedByHabit.get(input.habitId) ?? EMPTY,
      answered,
      asOf: input.localDate,
    }),
  };
}
