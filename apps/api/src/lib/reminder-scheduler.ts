import type { FastifyInstance } from "fastify";
import { runReminders } from "../services/reminder.service.js";
import { configurePush, pushEnabled } from "./push.js";

/**
 * The reminder tick (D136).
 *
 * A minute tick, like the backup scheduler beside it and for the same reason:
 * the schedule is a time of day, so the only question each minute is whether
 * anybody's local clock has just passed theirs. A cron parser would be more
 * general and would need a timezone argument, which is precisely the thing that
 * cannot be one value here — every account has its own.
 *
 * ## One instance, like the mail drainer
 *
 * **Two API processes would run two schedulers.** The mail drainer has the same
 * property and D104 wrote it down: one instance is the supported deployment
 * until a lock exists. Reminders are gentler about it than mail, because the
 * unique index on `reminder_sends` makes a double send impossible — the second
 * claim loses. What two schedulers would actually cost is doubled work, not
 * doubled notifications. That is the honest statement of the limit, and it is
 * why this is not a reason to add a lock today.
 *
 * ## Off is off
 *
 * Without a VAPID pair this does not start at all. Nothing ticks, nothing is
 * swept, and the log says so once, which is what an operator needs to see when
 * they wonder why a reminder never came.
 */

const TICK_MS = 60_000;

export function startReminderScheduler(app: FastifyInstance): () => void {
  if (!pushEnabled(app.config)) {
    app.log.info(
      "reminders are off: no VAPID keys. Generate a pair with `pnpm --filter api vapid`",
    );
    return () => {};
  }

  configurePush(app.config);

  let running = false;

  const tick = async () => {
    // A sweep that outlasts a minute must not start a second one on top of
    // itself: the claims would race and the work would double.
    if (running) return;
    running = true;

    try {
      const result = await runReminders(
        app.db,
        app.config,
        new Date(),
        undefined,
        /**
         * One line per removal (D136, amended). A subscription is deleted on
         * the first 404, 410 or 403 and never retried, and this is where that
         * becomes visible to whoever is reading the log.
         */
        (device) =>
          app.log.info(
            { subscription: device.id, host: device.host, reason: device.reason },
            "push subscription removed",
          ),
      );

      /**
       * Silent on an empty sweep, which is most of them. A line every minute
       * saying "nothing to do" is a log nobody reads, and this runs 1440 times
       * a day.
       */
      if (result.sent > 0 || result.removed > 0) {
        app.log.info({ ...result }, "reminders sent");
      }
    } catch (error) {
      app.log.error({ err: error }, "the reminder sweep failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();

  app.log.info("reminders are on, checking every minute");

  return () => clearInterval(timer);
}
