import { addDays } from "shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import type { LlmClient } from "../llm/client.js";
import { weeklyReviews } from "../db/schema.js";
import { COACH_PERSONA, NO_PRESCRIPTION } from "../llm/prompts/coach.js";
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
 * What is **not** built here is the Sunday job that would produce these without
 * being asked. That is Phase 8's item, it needs a scheduler decision of its own
 * (whose Sunday, in which timezone, and what happens to the week somebody was
 * away for), and inventing one here would be the kind of half-built scheduler
 * this project has had to unpick before. The review is produced when somebody
 * asks for it, which is a complete feature rather than a fragment of a job.
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

  const facts = await buildCoachFacts(userId, db, env, asOf);

  const result = await llm.chat({
    model: env.OLLAMA_MODEL_LARGE,
    messages: [
      {
        role: "system",
        content: [
          COACH_PERSONA,
          NO_PRESCRIPTION,
          "Du sammanfattar veckan som gått i två till fyra meningar. Du använder bara talen nedan " +
            "och hittar aldrig på ett tal. Du kommenterar mönster, du sätter inga mål.",
          "Det här är vad appen vet om personen just nu:",
          facts.text,
        ].join("\n\n"),
      },
      { role: "user", content: "Sammanfatta veckan." },
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

