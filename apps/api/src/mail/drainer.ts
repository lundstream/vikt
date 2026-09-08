import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/index.js";
import { workerHeartbeat } from "../db/schema.js";
import { drainMail } from "./queue.js";
import type { Mailer } from "./sender.js";

/**
 * The mail queue drainer, in the process that queues the mail (D104).
 *
 * ## What was wrong
 *
 * D88 made the drainer a separate process, for a good reason: nothing may be
 * sent inside a request, because an SMTP conversation takes seconds on a good
 * day and hangs on a bad one. What it did not do is arrange for that process to
 * exist anywhere. `pnpm --filter api mail:worker` was in the README, there was
 * no service for it in `infra/docker-compose.yml`, and nobody was running it.
 *
 * So an invite request queued two messages, both sat at `pending` with
 * `attempts: 0`, and the admin screen showed them as "Väntar", which is what a
 * message waiting its turn looks like. Meanwhile the mail settings test button
 * delivered instantly, because it sends directly (D102) and is the one path
 * that does not touch the queue. Every visible signal said mail worked.
 *
 * ## Why in-process is right, and why it does not contradict D88
 *
 * D88's rule is that **a request** must not wait on SMTP. An interval timer is
 * not a request: nobody is blocked on it, and a hung send delays only the next
 * tick. What the separate process bought was isolation the app never used, and
 * it cost the one thing that mattered, which is existing.
 *
 * A self-hosted single-instance app should have one thing to start. The CLI
 * worker stays for anyone who wants the old shape, and refuses to run alongside
 * this one, because two drainers on the same queue is how a password reset
 * arrives twice.
 */

const TICK_MS = 30_000;

/** The name this worker records its heartbeat under. */
export const MAIL_WORKER = "mail";

/**
 * Records a tick, whatever happened in it.
 *
 * Written on every tick including the empty ones, because the point of the row
 * is to answer "is anything running", and a heartbeat that only appears when
 * there is work cannot answer it.
 */
export async function recordTick(
  db: Db,
  sent: number,
  error: string | null,
): Promise<void> {
  await db
    .insert(workerHeartbeat)
    .values({
      name: MAIL_WORKER,
      lastTickAt: new Date(),
      sentSinceStart: sent,
      lastError: error,
    })
    .onConflictDoUpdate({
      target: workerHeartbeat.name,
      set: {
        lastTickAt: new Date(),
        sentSinceStart: sql`${workerHeartbeat.sentSinceStart} + ${sent}`,
        // Cleared by a good tick: a stale error beside a working queue is worse
        // than none, because it sends somebody looking for a problem that ended.
        lastError: error,
      },
    });
}

/** One pass, exported so a test can drive it without waiting for a timer. */
export async function drainOnce(db: Db, mailer: Mailer): Promise<number> {
  await mailer.refresh();
  const result = await drainMail(db, mailer);
  await recordTick(db, result.sent, null);
  return result.sent;
}

export function startMailDrainer(app: FastifyInstance): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // Re-read the settings every tick, so an admin who changes the mail
      // server does not also have to remember to restart anything.
      await app.mailer.refresh();
      if (!app.mailer.enabled) {
        await recordTick(app.db, 0, null);
        return;
      }

      const result = await drainMail(app.db, app.mailer);
      await recordTick(app.db, result.sent, null);
      if (result.sent || result.failed || result.retried) {
        app.log.info({ result }, "mail drained");
      }
    } catch (error) {
      // Never let one bad tick kill the timer: a dead drainer is a silent
      // queue, which is the whole defect this file exists to prevent.
      const reason = (error as Error).message.slice(0, 500);
      app.log.error({ err: error }, "mail drain tick failed");
      await recordTick(app.db, 0, reason).catch(() => {});
    } finally {
      running = false;
    }
  };

  // One immediately, so a queue that is already backed up at startup does not
  // wait half a minute, and so the heartbeat exists from the first second.
  void tick();

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** What the admin screen shows about the drainer. */
export async function readWorkerState(db: Db): Promise<{
  lastTickAt: string;
  sentSinceStart: number;
  lastError: string | null;
} | null> {
  const [row] = await db
    .select()
    .from(workerHeartbeat)
    .where(eq(workerHeartbeat.name, MAIL_WORKER))
    .limit(1);

  return row
    ? {
        lastTickAt: row.lastTickAt.toISOString(),
        sentSinceStart: row.sentSinceStart,
        lastError: row.lastError,
      }
    : null;
}
