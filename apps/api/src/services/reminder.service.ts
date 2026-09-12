import { and, eq, sql } from "drizzle-orm";
import {
  habitReminderBody,
  HABIT_REMINDER_URL,
  isWeekend,
  localMinuteOfDay,
  REMINDER_TEXT,
  REMINDER_URL,
  toLocalDate,
} from "shared";
import type { Db } from "../db/index.js";
import { dailyLog, habits, profiles, pushSubscriptions, reminderSends, users } from "../db/schema.js";
import { isHabitCheckedOn } from "../repositories/habit.repo.js";
import { findWeightForDay } from "../repositories/weight.repo.js";
import type { Env } from "../env.js";
import { pushEnabled, sendPush, type PushPayload } from "../lib/push.js";

/**
 * The two reminders (D136).
 *
 * "Väg dig" in the morning and "Fyll i dagen" in the evening, each with its own
 * time and its own switch, both off until somebody turns them on.
 *
 * Each has **two** of those: one pair for Monday to Friday and one for Saturday
 * and Sunday, so the morning reminder can be 07:00 on a Tuesday and 09:00 on a
 * Sunday, or off on a Sunday while staying on for the week. Which pair applies
 * follows from the date the person is having, below.
 *
 * ## Four rules, and each one is a decision
 *
 * **The time is the user's, not the server's.** 07:00 means seven in the
 * morning where the person is. That is a different instant for two accounts and
 * a different instant for one account in March, so the scheduler asks each
 * profile what time it is *there* rather than comparing against a UTC hour.
 * `toLocalDate` is the app's own helper (§3, D39); the machine clock is never
 * consulted for a day boundary.
 *
 * **The weekend is the user's too.** Friday 23:30 on a server in London is
 * already Saturday in Stockholm, and that account gets its Saturday time, not
 * Friday's. The day is read off the local date `toLocalDate` already produced,
 * so there is one timezone conversion per profile per tick and nothing that can
 * disagree with it.
 *
 * **Skipped when it has already happened.** The morning one does not fire if a
 * weight is already logged for that local date; the evening one does not fire
 * if a daily log exists. Checked **at send time**, not when the schedule was
 * set, because somebody who weighs themselves at 06:40 has answered the
 * question and a reminder then is the app failing to notice.
 *
 * **Never twice for one day.** `reminder_sends` has a unique index on
 * `(user_id, kind, local_date)` and the insert is the claim: a conflict means
 * somebody already has that day. That is the guard rather than a check in code,
 * because a retry, a second process or a clock stepping backwards all converge
 * on the same row.
 *
 * **Late is worse than never.** A device offline at 07:00 does not get the
 * reminder at 11:00. The window is 30 minutes; past it the day is marked as
 * handled without sending, so tomorrow starts clean. The push TTL says the same
 * thing to the push service for the case where the device returns after we have
 * already sent.
 */

/**
 * Which reminder this is.
 *
 * A habit's reminder carries the habit's id **in the kind** (D137), which is
 * what lets the existing unique index on `(user_id, kind, local_date)` be the
 * never-twice guard for it too: two habits are two kinds, so neither can claim
 * the other's day, and no column had to be added to make room.
 */
export type ReminderKind = "weigh" | "day" | `habit:${string}`;

/** The habit id a kind names, or null when it names one of the fixed two. */
export function habitIdOf(kind: ReminderKind): string | null {
  return kind.startsWith("habit:") ? kind.slice("habit:".length) : null;
}

/** How long after the chosen minute a reminder may still be sent. */
export const SEND_WINDOW_MINUTES = 30;

/**
 * Whether `now` is inside the window that follows `scheduledMinute`.
 *
 * Deliberately not "is it past the time": that would fire a 07:00 reminder at
 * 23:00 for anybody whose scheduler was down all day. The window closes, and
 * `claimDay` below records the day as handled so it does not reopen.
 *
 * Midnight wrap is handled by comparing on the minute-of-day line without
 * wrapping: a window that would cross midnight simply ends at midnight, which
 * is correct, because the next minute is a different `local_date` and therefore
 * a different reminder.
 */
export function insideWindow(minuteNow: number, scheduledMinute: number): boolean {
  return minuteNow >= scheduledMinute && minuteNow < scheduledMinute + SEND_WINDOW_MINUTES;
}

/**
 * Whether the thing the reminder is about has already happened today.
 *
 * The weight side goes through `findWeightForDay` rather than reading
 * `weight_log` here. D47 gives that table one owner, and the ownership rule
 * caught this on the first lint: the question is row existence rather than a
 * derived figure, but "I only need a cheap read" is exactly the reasoning that
 * produced four call sites building the intake index themselves (D44).
 */
export async function alreadyDone(
  userId: string,
  db: Db,
  kind: ReminderKind,
  localDate: string,
): Promise<boolean> {
  if (kind === "weigh") {
    return (await findWeightForDay(userId, db, localDate)) !== null;
  }

  /**
   * A habit already ticked today is the same case as a weight already logged:
   * the question has been answered, and asking again is the app failing to
   * notice. Unticked is **not** done, which is the difference between a
   * reminder and a report.
   */
  const habitId = habitIdOf(kind);
  if (habitId !== null) return isHabitCheckedOn(userId, db, habitId, localDate);


  const [row] = await db
    .select({ id: dailyLog.id })
    .from(dailyLog)
    .where(and(eq(dailyLog.userId, userId), eq(dailyLog.localDate, localDate)))
    .limit(1);
  return row !== undefined;
}

/**
 * Claims a day for one reminder, returning whether this caller got it.
 *
 * `ON CONFLICT DO NOTHING` plus "did a row come back" is the whole
 * never-twice rule. Claiming happens **before** sending, so a crash between
 * the two costs one reminder rather than producing two.
 */
export async function claimDay(
  userId: string,
  db: Db,
  kind: ReminderKind,
  localDate: string,
): Promise<boolean> {
  const claimed = await db
    .insert(reminderSends)
    .values({ userId, kind, localDate })
    .onConflictDoNothing()
    .returning({ id: reminderSends.id });

  return claimed.length > 0;
}

/**
 * The copy, in the app's register: no dashes, no exclamation, no guilt.
 *
 * A habit's body is the habit's own name, which is why this takes one: the
 * words are the user's, and the app supplies only "Kom ihåg".
 */
export function payloadFor(kind: ReminderKind, habitName?: string): PushPayload {
  const habitId = habitIdOf(kind);
  if (habitId !== null) {
    return {
      title: "Vikt",
      body: habitReminderBody(habitName ?? ""),
      url: HABIT_REMINDER_URL,
      /**
       * Tagged per habit, so two habits due at eight o'clock are two
       * notifications rather than one replacing the other on the lock screen.
       */
      tag: `vikt-habit-${habitId}`,
    };
  }

  const fixed = kind as "weigh" | "day";
  return {
    title: "Vikt",
    body: REMINDER_TEXT[fixed],
    url: REMINDER_URL[fixed],
    tag: `vikt-${fixed}`,
  };
}

export type DueReminder = {
  userId: string;
  kind: ReminderKind;
  localDate: string;
  /** The habit's name, carried so the send does not need a second query. */
  habitName?: string;
};

/**
 * Everybody who should be reminded right now.
 *
 * Separated from the sending so the rules can be tested without a push service
 * and without a network, which is most of what there is to get wrong here.
 * Disabled accounts are excluded: a reminder to somebody who cannot sign in is
 * a notification with nowhere to go.
 */
export async function dueNow(db: Db, now: Date): Promise<DueReminder[]> {
  const rows = await db
    .select({
      userId: profiles.userId,
      timezone: profiles.timezone,
      remindWeigh: profiles.remindWeigh,
      remindWeighMinute: profiles.remindWeighMinute,
      remindDay: profiles.remindDay,
      remindDayMinute: profiles.remindDayMinute,
      remindWeighWeekend: profiles.remindWeighWeekend,
      remindWeighWeekendMinute: profiles.remindWeighWeekendMinute,
      remindDayWeekend: profiles.remindDayWeekend,
      remindDayWeekendMinute: profiles.remindDayWeekendMinute,
    })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(sql`${users.disabledAt} is null`);

  const due: DueReminder[] = [];

  for (const row of rows) {
    /**
     * Cheap exit for the common case of an account that has never turned any of
     * this on. All four switches, because being on only at the weekend is a
     * setting somebody will have.
     */
    if (!row.remindWeigh && !row.remindDay && !row.remindWeighWeekend && !row.remindDayWeekend) {
      continue;
    }

    /**
     * An invalid timezone on a profile must not take the whole run down with
     * it: everybody else still gets their reminder, and the bad row is simply
     * skipped. `Intl` throws on a name it does not know.
     */
    let minuteNow: number;
    let localDate: string;
    try {
      minuteNow = localMinuteOfDay(now, row.timezone);
      localDate = toLocalDate(now, row.timezone);
    } catch {
      continue;
    }

    /**
     * Read from the local date rather than from `now`, so the weekend follows
     * the person. The two pairs never combine: a Saturday consults only the
     * weekend switch, and a weekday only the other one.
     */
    const weekend = isWeekend(localDate);

    const weigh = weekend
      ? { on: row.remindWeighWeekend, minute: row.remindWeighWeekendMinute }
      : { on: row.remindWeigh, minute: row.remindWeighMinute };
    const day = weekend
      ? { on: row.remindDayWeekend, minute: row.remindDayWeekendMinute }
      : { on: row.remindDay, minute: row.remindDayMinute };

    if (weigh.on && insideWindow(minuteNow, weigh.minute)) {
      due.push({ userId: row.userId, kind: "weigh", localDate });
    }
    if (day.on && insideWindow(minuteNow, day.minute)) {
      due.push({ userId: row.userId, kind: "day", localDate });
    }
  }

  due.push(...(await habitsDueNow(db, now)));

  return due;
}

/**
 * The habits whose own reminder is due (D137).
 *
 * A separate query rather than a third pair of columns on the profile, because
 * a habit reminder belongs to the habit: deleting the habit takes it with it,
 * and an account with no habits reads no rows here at all.
 *
 * The timezone still comes from the profile, and the weekday-or-weekend choice
 * is made exactly as it is above, from the date the user is having.
 */
async function habitsDueNow(db: Db, now: Date): Promise<DueReminder[]> {
  const rows = await db
    .select({
      userId: habits.userId,
      habitId: habits.id,
      name: habits.name,
      timezone: profiles.timezone,
      remind: habits.remind,
      remindMinute: habits.remindMinute,
      remindWeekend: habits.remindWeekend,
      remindWeekendMinute: habits.remindWeekendMinute,
    })
    .from(habits)
    .innerJoin(profiles, eq(profiles.userId, habits.userId))
    .innerJoin(users, eq(users.id, habits.userId))
    .where(
      and(
        sql`${users.disabledAt} is null`,
        sql`${habits.archivedAt} is null`,
        sql`(${habits.remind} or ${habits.remindWeekend})`,
      ),
    );

  const due: DueReminder[] = [];

  for (const row of rows) {
    let minuteNow: number;
    let localDate: string;
    try {
      minuteNow = localMinuteOfDay(now, row.timezone);
      localDate = toLocalDate(now, row.timezone);
    } catch {
      continue;
    }

    const pair = isWeekend(localDate)
      ? { on: row.remindWeekend, minute: row.remindWeekendMinute }
      : { on: row.remind, minute: row.remindMinute };

    if (pair.on && insideWindow(minuteNow, pair.minute)) {
      due.push({
        userId: row.userId,
        kind: `habit:${row.habitId}`,
        localDate,
        habitName: row.name,
      });
    }
  }

  return due;
}

export type RunResult = { considered: number; sent: number; skipped: number; removed: number };

/**
 * The host of an endpoint, which is the part safe to log.
 *
 * The rest of the URL is a bearer token for notifying that device; a log file
 * is not where that belongs, and the host is what an operator actually reads
 * ("WNS is rejecting these", "FCM is").
 */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown host";
  }
}

/**
 * One pass: find who is due, skip what has happened, claim the day, send.
 *
 * Returns counts rather than logging them, so the caller decides what a run is
 * worth saying out loud and the function stays testable.
 */
export async function runReminders(
  db: Db,
  env: Env,
  now: Date,
  send = sendPush,
  /**
   * Called once per deleted subscription, so the scheduler can log one line
   * each (D136, amended 2026-09-12).
   *
   * A count told an operator that something was removed and never which
   * device, which is the wrong half: "two endpoints were dropped" is a number,
   * "the phone labelled Mozilla/5.0 … on wns2-db5p.notify.windows.com answered
   * 410" is a fact somebody can act on. The **host**, never the whole endpoint:
   * the token in it is the capability to notify that device.
   */
  onRemoved?: (device: { id: string; host: string; reason: string }) => void,
): Promise<RunResult> {
  const result: RunResult = { considered: 0, sent: 0, skipped: 0, removed: 0 };
  if (!pushEnabled(env)) return result;

  for (const reminder of await dueNow(db, now)) {
    result.considered += 1;

    /**
     * Checked now rather than when the window opened. Somebody who weighed
     * themselves at 06:40 has answered the question, and the reminder would be
     * the app admitting it was not paying attention.
     */
    if (await alreadyDone(reminder.userId, db, reminder.kind, reminder.localDate)) {
      /**
       * The day is still claimed, so this is not reconsidered every minute for
       * the rest of the window. It is a skip, not a send.
       */
      await claimDay(reminder.userId, db, reminder.kind, reminder.localDate);
      result.skipped += 1;
      continue;
    }

    if (!(await claimDay(reminder.userId, db, reminder.kind, reminder.localDate))) {
      result.skipped += 1;
      continue;
    }

    const devices = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, reminder.userId));

    const payload = payloadFor(reminder.kind, reminder.habitName);

    for (const device of devices) {
      const outcome = await send(
        { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
        payload,
      );

      if (outcome.status === "sent") {
        await db
          .update(pushSubscriptions)
          .set({ lastSeenAt: new Date() })
          .where(eq(pushSubscriptions.id, device.id));
        result.sent += 1;
        continue;
      }

      /**
       * Removed on the **first** failure of this kind, not after a count
       * (§6, phase 11). The push service is saying the browser threw this
       * subscription away; retrying it is a row that can only ever fail.
       */
      if (outcome.status === "gone") {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, device.id));
        result.removed += 1;
        onRemoved?.({ id: device.id, host: hostOf(device.endpoint), reason: outcome.reason });
      }
    }
  }

  return result;
}
