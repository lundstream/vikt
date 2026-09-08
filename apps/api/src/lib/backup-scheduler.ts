import type { FastifyInstance } from "fastify";
import { runBackup, readBackupSettings } from "../services/backup.service.js";

/**
 * The schedule D96 wrote and never installed (D103).
 *
 * `infra/backup.sh` has existed since D96, with a cron line in its own header
 * comment. Nobody ran `crontab -e`, so the only backups that ever existed were
 * the ones taken by hand during a verification pass. That is the whole reason
 * this lives in the app now: a schedule inside the thing being backed up starts
 * when the thing starts, and there is no second step to forget.
 *
 * **A minute tick, not a cron parser.** The schedule is one time of day, so the
 * only question each minute is whether the clock has just passed it. A cron
 * expression would be more general and would need a parser, a timezone
 * argument, and a test suite of its own, to express something nobody has asked
 * for.
 *
 * It skips a tick while a run is in flight, so a backup that takes longer than a
 * minute cannot start a second one on top of itself.
 */

const TICK_MS = 60_000;

export function startBackupScheduler(app: FastifyInstance): () => void {
  let running = false;
  let lastRunOn: string | null = null;

  const tick = async () => {
    if (running) return;

    try {
      const settings = await readBackupSettings(app.db);
      if (settings.scheduleMinute === null) return;

      const now = new Date();
      const minuteOfDay = now.getHours() * 60 + now.getMinutes();
      const today = now.toISOString().slice(0, 10);

      // At or past the time, and not already done today. "At or past" rather
      // than "equals" so a process that was down at the scheduled minute still
      // takes the day's backup when it comes back.
      if (minuteOfDay < settings.scheduleMinute) return;
      if (lastRunOn === today) return;

      running = true;
      lastRunOn = today;
      const outcome = await runBackup(app.db, app.config, null);
      app.log.info({ outcome }, "scheduled backup");
    } catch (error) {
      // Never let one bad tick kill the timer: a dead scheduler is a silent
      // absence of backups, which is the failure this whole file is about.
      app.log.error({ err: error }, "backup scheduler tick failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  // Never hold the process open. A backup is not a reason to refuse to exit.
  timer.unref();

  return () => clearInterval(timer);
}
