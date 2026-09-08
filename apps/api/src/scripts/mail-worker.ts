/**
 * Drains the outbound mail queue (D88).
 *
 *   pnpm --filter api mail:worker
 *
 * A separate process, on an interval, because nothing is ever sent inside a
 * request: an SMTP conversation takes seconds on a good day and hangs on a bad
 * one, and a password-reset request that waits for a mail server is a request
 * that fails when the mail server does.
 *
 * Exits immediately when mail is unconfigured rather than looping over an empty
 * queue forever. A self-hosted install without a mail server is a supported
 * configuration, and a worker that runs anyway would be a process doing nothing
 * in the process list, which is how a real failure gets missed.
 */
import "../lib/dotenv.js";
import { loadEnv } from "../env.js";
import { createDb } from "../db/index.js";
import { createMailer } from "../mail/sender.js";
import { drainMail } from "../mail/queue.js";

const INTERVAL_MS = 30_000;

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

/**
 * The settings come from the database now (D102), so the mailer needs the
 * database before it can say whether it is enabled. That is the other way round
 * from how this used to read.
 *
 * It re-reads on every tick rather than once. This is a long-lived process, and
 * an admin who changes the mail server while it runs should not also have to
 * remember to restart it, which is exactly the kind of thing nobody remembers.
 */
/**
 * Refuses to run beside the in-process drainer (D104).
 *
 * The API drains the queue itself now. Two drainers on one queue send the same
 * password reset twice, and the second copy arrives looking exactly as valid as
 * the first. Set MAIL_WORKER_IN_PROCESS=false to use this instead.
 */
if (env.MAIL_WORKER_IN_PROCESS) {
  process.stdout.write(
    "The API drains the queue itself (MAIL_WORKER_IN_PROCESS=true), so this would " +
      "be a second drainer on the same queue. Set MAIL_WORKER_IN_PROCESS=false to " +
      "use this worker instead.\n",
  );
  await client.end();
  process.exit(0);
}

const mailer = createMailer(() => db, env);
await mailer.refresh();

if (!mailer.enabled) {
  process.stdout.write(
    "Mail is not configured. Set it up in the admin screens under Mejl. Nothing to drain.\n",
  );
  await client.end();
  process.exit(0);
}
let stopping = false;

async function tick(): Promise<void> {
  try {
    await mailer.refresh();
    const result = await drainMail(db, mailer);
    if (result.sent || result.failed || result.retried) {
      process.stdout.write(
        `sent ${result.sent}, retrying ${result.retried}, gave up on ${result.failed}\n`,
      );
    }
  } catch (error) {
    // Never let one bad drain kill the worker: the next tick may well succeed,
    // and a dead worker is a silent queue.
    process.stderr.write(`drain failed: ${(error as Error).message}\n`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

process.stdout.write(`Draining outbound mail every ${INTERVAL_MS / 1000}s.\n`);
while (!stopping) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

await client.end();
