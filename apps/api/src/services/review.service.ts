import { addDays, buildLoggedDays, eachDay, isWeekend, localMinuteOfDay, toLocalDate } from "shared";
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import type { LlmClient } from "../llm/client.js";
import { profiles, users, weeklyReviews } from "../db/schema.js";
import { getWeightRows } from "./series.service.js";
import { resolveIntake } from "./intake.service.js";
import { getDailyLogs } from "./daily.service.js";
import { insideWindow } from "./reminder.service.js";
import { buildCoachPrompt, REVIEW_TASK } from "../llm/prompts/coach.js";
import { coachToneFor } from "./coach.service.js";
import { buildCoachFacts } from "../llm/coach-context.js";
import { checkReply } from "../llm/coach-guard.js";

/**
 * The weekly review (D139), the other half of what the Coach page holds.
 *
 * **The same persona file and the same guardrail as the chat.** §6 phase 8b's
 * voice rule is that the two must not sound like different people, and the way
 * to guarantee that is not to describe the voice twice: `prompts/coach.ts` is
 * the only file in this codebase that says how the coach talks, and both
 * surfaces read it. The reply goes through `checkReply` for the same reason a
 * chat turn does — a summary is prose with numbers in it, and a number in prose
 * is exactly what the check exists for.
 *
 * **It comments, it never prescribes.** That is §6 phase 8's own wording for
 * the review, and `NO_PRESCRIPTION` is the sentence that carries it.
 *
 * **The Sunday job is here too** (D141), on the reminder scheduler's machinery:
 * a minute tick that asks each profile what time it is *there*. Its rules are
 * decisions rather than parameters, and they are written down in D141: Sunday
 * 20:00 in the user's own timezone, at least four logged days in the week or
 * nothing is written at all, idempotent per user and week, and a week somebody
 * was away produces no review and no sentence about the absence.
 *
 * A review is still written on request as well. The two paths meet at the same
 * unique index, so asking on a Sunday afternoon and the sweep arriving at eight
 * cannot produce two.
 */

/** The Monday on or before a date, in the user's own local calendar. */
export function weekStartOf(localDate: string): string {
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  // getUTCDay: 0 is Sunday. Monday is the start of the week here, as in Sweden.
  const back = day === 0 ? 6 : day - 1;
  return addDays(localDate, -back);
}

export type ReviewOutcome =
  | { status: "written"; id: string; body: string }
  | { status: "exists"; id: string; body: string }
  | { status: "unreachable" }
  | { status: "refused"; reason: string };

/**
 * Writes the review for the week containing `asOf`, unless one is already there.
 *
 * Idempotent by the unique index on `(user_id, week_start)`: asking twice in one
 * week gives the same text back rather than a second opinion, which matters
 * because a review that changed every time it was read would not be a record of
 * anything.
 */
export async function generateWeeklyReview(
  userId: string,
  db: Db,
  env: Env,
  llm: LlmClient,
  asOf: string,
): Promise<ReviewOutcome> {
  const weekStart = weekStartOf(asOf);

  const [existing] = await db
    .select()
    .from(weeklyReviews)
    .where(and(eq(weeklyReviews.userId, userId), eq(weeklyReviews.weekStart, weekStart)))
    .limit(1);

  if (existing) return { status: "exists", id: existing.id, body: existing.body };

  if (!llm.enabled || !(await llm.reachable())) return { status: "unreachable" };

  const [facts, tone] = await Promise.all([
    buildCoachFacts(userId, db, env, asOf),
    coachToneFor(userId, db),
  ]);

  /**
   * The same prompt the chat uses, in the same chosen tone (D140).
   *
   * That is §6 phase 8b's voice rule made structural: the review and the chat
   * are one voice because they are one prompt, and a person who picked a tone
   * picked it for both.
   */
  const result = await llm.chat({
    model: env.OLLAMA_MODEL_LARGE,
    messages: [
      { role: "system", content: buildCoachPrompt(tone, facts.text) },
      { role: "user", content: REVIEW_TASK },
    ],
    timeoutMs: env.OLLAMA_JOB_TIMEOUT_MS,
    temperature: 0.6,
  });

  if (!result.ok) return { status: "unreachable" };

  const verdict = checkReply(result.content, facts);
  if (!verdict.ok) return { status: "refused", reason: verdict.reason };

  const [row] = await db
    .insert(weeklyReviews)
    .values({
      userId,
      weekStart,
      stats: { chars: facts.chars, figures: facts.figures },
      body: result.content.trim(),
      model: result.model,
    })
    .returning({ id: weeklyReviews.id, body: weeklyReviews.body });

  return { status: "written", id: row!.id, body: row!.body };
}

/* ------------------------------------------------------------ the Sunday job */

/** When the sweep writes, in the user's own local time. */
export const REVIEW_MINUTE = 20 * 60;

/**
 * How many days of the week must carry **something** before a week is worth
 * summarising (D141).
 *
 * Four of seven. Below that there is no week to describe: a summary built from
 * one weighing is either padding or, worse, a sentence about how little was
 * logged, which is the failure state §3 forbids arriving by the back door. The
 * honest output for a quiet week is nothing at all, and the card simply does
 * not appear.
 */
export const REVIEW_MIN_LOGGED_DAYS = 4;

/** Days in `[from, to]` that carry any log at all. The streak's definition. */
export async function loggedDaysIn(
  userId: string,
  db: Db,
  from: string,
  to: string,
): Promise<number> {
  const [weights, dailyLogs, intake] = await Promise.all([
    getWeightRows(userId, db, { from, to }),
    getDailyLogs(userId, db, { from, to }),
    resolveIntake(userId, db, { from, to }),
  ]);

  const days = buildLoggedDays({
    weight: weights.map((row) => ({ localDate: row.localDate })),
    daily: dailyLogs.map((row) => ({ localDate: row.localDate })),
    food: [...eachDay(from, to)]
      .filter((day) => (intake.get(day) ?? 0) > 0)
      .map((day) => ({ localDate: day })),
  });

  return days.size;
}

export type SweepResult = { considered: number; written: number; quiet: number };

/**
 * One pass of the Sunday job.
 *
 * Called every minute by the scheduler, and on almost every minute it finds
 * nobody: the question each time is only whether some account's local clock has
 * just passed Sunday at eight, which is the same shape the reminder sweep has
 * and for the same reason. A cron expression would need one timezone, and a
 * timezone is exactly the thing that cannot be one value here.
 */
export async function runWeeklyReviews(
  db: Db,
  env: Env,
  llm: LlmClient,
  now: Date,
): Promise<SweepResult> {
  const result: SweepResult = { considered: 0, written: 0, quiet: 0 };
  if (!llm.enabled) return result;

  const rows = await db
    .select({ userId: profiles.userId, timezone: profiles.timezone })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(sql`${users.disabledAt} is null`);

  for (const row of rows) {
    let localDate: string;
    let minuteNow: number;
    try {
      localDate = toLocalDate(now, row.timezone);
      minuteNow = localMinuteOfDay(now, row.timezone);
    } catch {
      // An unusable timezone skips this profile and nothing else, exactly as it
      // does in the reminder sweep.
      continue;
    }

    /**
     * Sunday, in the user's own calendar. `isWeekend` is the shared helper the
     * reminders already use (D136), so there is one notion of which day it is
     * and it is never the server's.
     */
    if (!isWeekend(localDate)) continue;
    if (new Date(`${localDate}T00:00:00Z`).getUTCDay() !== 0) continue;
    if (!insideWindow(minuteNow, REVIEW_MINUTE)) continue;

    result.considered += 1;

    const weekStart = weekStartOf(localDate);
    const logged = await loggedDaysIn(row.userId, db, weekStart, localDate);
    if (logged < REVIEW_MIN_LOGGED_DAYS) {
      result.quiet += 1;
      continue;
    }

    const outcome = await generateWeeklyReview(row.userId, db, env, llm, localDate);
    if (outcome.status === "written") result.written += 1;
  }

  return result;
}
