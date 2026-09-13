import type { FastifyInstance } from "fastify";
import { runWeeklyReviews } from "../services/review.service.js";

/**
 * The Sunday job (D141), §6 phase 8.
 *
 * A minute tick, like the reminder scheduler beside it and reusing its shape
 * for the same reason: the schedule is **a time of day in somebody's own
 * timezone**, so the only question each minute is whether an account's local
 * clock has just passed Sunday at eight. A cron expression would have to name
 * one timezone, and a timezone is exactly the value that cannot be one thing
 * here.
 *
 * ## One instance, like the mail drainer and the reminders
 *
 * Two API processes would run two schedulers. D104 wrote that down for mail and
 * D136 repeated it for reminders; it is true here too, and the consequence is
 * the gentler one: `weekly_reviews` has a unique index on `(user_id,
 * week_start)`, so a second sweep cannot write a second review. What it would
 * cost is a wasted generation on a shared GPU, not a duplicate. That is the
 * honest limit, and it is why this is not a reason to add a lock today.
 *
 * ## Off is off
 *
 * Without the LLM layer this does not start at all. The line is logged once,
 * which is what an operator needs when they wonder why no summary ever appears.
 */

const TICK_MS = 60_000;

export function startReviewScheduler(app: FastifyInstance): () => void {
  if (!app.llm.enabled) {
    app.log.info("the weekly review is off: no LLM layer configured");
    return () => {};
  }

  let running = false;

  const tick = async () => {
    /**
     * A sweep that outlasts a minute must not start a second one on top of
     * itself. This one can genuinely take minutes: each review is a generation
     * on a shared box, and they are deliberately sequential inside the sweep so
     * that twenty accounts do not arrive at one GPU at once.
     */
    if (running) return;
    running = true;

    try {
      const result = await runWeeklyReviews(app.db, app.config, app.llm, new Date());

      // Silent on an empty sweep, which is all but a handful of the 1 440 a day.
      if (result.written > 0 || result.quiet > 0) {
        app.log.info({ ...result }, "weekly reviews swept");
      }
    } catch (error) {
      app.log.error({ err: error }, "the weekly review sweep failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  app.log.info("the weekly review is on, checking every minute for Sunday at 20:00");

  return () => clearInterval(timer);
}
