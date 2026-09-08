import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { outboundEmail } from "../db/schema.js";
import type { Mailer } from "./sender.js";
import type { RenderedMail } from "./templates.js";

/**
 * The outbound queue, and the worker that drains it (D88).
 *
 * **Nothing is sent inside a request.** An SMTP conversation takes seconds on a
 * good day and hangs on a bad one; a password-reset request that waits for a
 * mail server is a request that fails when the mail server does, and a
 * registration that waits for one fails at the worst possible moment. Queueing
 * is a single insert, and the user's answer does not depend on anyone else's
 * infrastructure being up.
 *
 * The same shape as the LLM job queue on purpose: status, attempts, last error,
 * next attempt. Two queues that behave differently are two things to learn.
 */

/** How long to wait before attempt n, doubling, capped at an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * After this many attempts a message is `failed` and stops being retried.
 *
 * Not because it becomes undeliverable, but because a message nobody has
 * received after six tries over roughly two hours needs a person to look at it,
 * and the admin view is where they do that. Silent infinite retry is how a
 * queue hides a broken configuration for a month.
 */
export const MAX_ATTEMPTS = 6;

/**
 * Adds a rendered message to the queue. Never sends.
 *
 * `priority` exists for one caller (D109): the admin test mail, which used to
 * bypass the queue entirely. That bypass is why a delivered test coexisted for
 * an hour with a queue nothing was draining — the one button that gave feedback
 * was the one that did not exercise the path everything else uses.
 */
export async function queueMail(
  db: Db,
  to: string,
  mail: RenderedMail,
  options: { priority?: number } = {},
): Promise<string> {
  const [row] = await db
    .insert(outboundEmail)
    .values({
      toAddress: to,
      template: mail.template,
      subject: mail.subject,
      bodyText: mail.text,
      bodyHtml: mail.html,
      status: "pending",
      priority: options.priority ?? 10,
      nextAttemptAt: new Date(),
    })
    .returning({ id: outboundEmail.id });

  return row!.id;
}

export type DrainResult = { sent: number; failed: number; retried: number };

/**
 * Sends what is due, once.
 *
 * Called on an interval by the worker and directly by tests. Takes `now` rather
 * than reading the clock, for the same reason every function in `calc/` does:
 * a backoff that cannot be tested without waiting for it is a backoff nobody
 * tests.
 */
export async function drainMail(
  db: Db,
  mailer: Mailer,
  now: Date = new Date(),
  limit = 20,
): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, failed: 0, retried: 0 };
  if (!mailer.enabled) return result;

  const due = await db
    .select()
    .from(outboundEmail)
    .where(
      and(
        eq(outboundEmail.status, "pending"),
        or(isNull(outboundEmail.nextAttemptAt), lte(outboundEmail.nextAttemptAt, now)),
      ),
    )
    // Priority first, then age. Without the second key a burst of equal
    // priority would come back in whatever order the planner liked, and a
    // reset queued before an announcement should still go first.
    .orderBy(asc(outboundEmail.priority), asc(outboundEmail.createdAt))
    .limit(limit);

  for (const row of due) {
    const attempts = row.attempts + 1;
    const outcome = await mailer.send({
      to: row.toAddress,
      subject: row.subject,
      text: row.bodyText,
      html: row.bodyHtml,
    });

    if (outcome.ok) {
      /**
       * Kept, not deleted, unlike the offline write queue.
       *
       * That queue deletes on success because the server is the record of what
       * was logged. Here there is no other record: "did the reset mail go out"
       * is a question support gets asked, and the only place that can answer it
       * is this row.
       */
      await db
        .update(outboundEmail)
        .set({ status: "sent", attempts, sentAt: now, lastError: null })
        .where(eq(outboundEmail.id, row.id));
      result.sent += 1;
      continue;
    }

    const giveUp = outcome.permanent || attempts >= MAX_ATTEMPTS;
    await db
      .update(outboundEmail)
      .set({
        status: giveUp ? "failed" : "pending",
        attempts,
        lastError: outcome.reason,
        nextAttemptAt: giveUp ? null : new Date(now.getTime() + backoffMs(attempts)),
      })
      .where(eq(outboundEmail.id, row.id));

    if (giveUp) result.failed += 1;
    else result.retried += 1;
  }

  return result;
}

/** What the admin view lists: everything not yet sent, newest first. */
export async function listMail(db: Db, limit = 50) {
  return db
    .select()
    .from(outboundEmail)
    .orderBy(sql`${outboundEmail.createdAt} DESC`)
    .limit(limit);
}
