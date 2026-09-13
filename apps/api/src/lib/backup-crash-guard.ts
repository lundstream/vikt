import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { backupRuns } from "../db/schema.js";

/**
 * A backup destination must never take the API down (D132).
 *
 * ## What happened
 *
 * An admin pressed "test connection" against a real share. `@marsaud/smb2`
 * reached NTLM, called `createCipheriv("des-ecb", ...)`, and OpenSSL 3 refused
 * — it has no DES. The library threw that **from inside a socket callback**,
 * which is not inside any promise chain, so the `try/catch` around the connect
 * could not see it. Node treated it as an uncaught exception and the process
 * exited. The whole app was down until somebody restarted it, and nothing in
 * the app said why.
 *
 * ## Why a `try/catch` is not enough, and never will be
 *
 * This is a property of the class of library, not of one library. An SMB client
 * is a socket state machine: it parses bytes in a `data` handler and calls back
 * into user code from there. Anything it throws on that path is thrown into the
 * event loop, and no `await` anywhere can catch it. Swapping libraries changes
 * which line throws, not whether an uncaught throw is possible.
 *
 * So the guard is at the process, and it is deliberately narrow:
 *
 * - it only intervenes **while a backup is in flight**, which is a window of
 *   seconds a few times a day, not a permanent net under the whole API;
 * - it **marks the run failed** with the error, so the admin screen shows what
 *   happened rather than a run that started and never finished;
 * - it **logs with the destination**, because "the SMB write threw" is a
 *   different problem from "the disk filled up" and the log has to say which;
 * - and for anything thrown while no backup is running it **restores the
 *   default and exits**, because swallowing arbitrary corruption is worse than
 *   crashing. A process that has thrown from an unknown place is a process
 *   whose state nobody can vouch for.
 *
 * That last point is the whole reason this is not a blanket `uncaughtException`
 * handler. A blanket one turns every future bug into a silent one.
 */

/** The run this process is in the middle of, or null. */
let inFlight: { runId: string; destination: string; db: Db } | null = null;

/** Whether the guard has been installed, so tests can install it once. */
let installed = false;

/**
 * Marks the window during which an uncaught throw is attributable to a backup.
 *
 * Takes the run id so the guard can write the failure to the row that is
 * already there: `runBackup` inserts a `running` row before it starts work,
 * precisely so a crash leaves evidence.
 */
export function backupInFlight(runId: string, destination: string, db: Db): void {
  inFlight = { runId, destination, db };
}

export function backupSettled(): void {
  inFlight = null;
}

/** For tests and for the admin screen's own reasoning. */
export function currentBackup(): { runId: string; destination: string } | null {
  return inFlight === null ? null : { runId: inFlight.runId, destination: inFlight.destination };
}

/**
 * Installs the handler. Idempotent, because the test suite builds many apps in
 * one process and forty handlers on one event is its own leak.
 */
export function installBackupCrashGuard(app: FastifyInstance): void {
  if (installed) return;
  installed = true;

  process.on("uncaughtException", (error) => {
    const running = inFlight;

    if (running === null) {
      /**
       * Not ours. Restore Node's own behaviour rather than pretending to
       * handle it: log it the way the process would have, and exit non-zero so
       * the container restarts and the failure stays loud.
       */
      app.log.fatal({ err: error }, "uncaught exception outside a backup; exiting");
      process.exit(1);
    }

    inFlight = null;

    app.log.error(
      { err: error, destination: running.destination, runId: running.runId },
      "the backup destination threw outside any promise chain; the run is marked " +
        "failed and the API keeps serving",
    );

    /**
     * Best effort, and deliberately not awaited: this handler is running after
     * the stack that threw has been abandoned, and the one thing it must not do
     * is throw again. A failure to record the failure is logged and dropped.
     */
    void running.db
      .update(backupRuns)
      .set({
        finishedAt: new Date(),
        status: "failed",
        error: `The backup destination threw an error the app could not catch: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 500),
      })
      .where(eq(backupRuns.id, running.runId))
      .catch((writeError: unknown) => {
        app.log.error({ err: writeError }, "could not mark the crashed backup run failed");
      });
  });
}

/** Tests need to undo the install. Nothing in the app does. */
export function resetBackupCrashGuardForTests(): void {
  installed = false;
  inFlight = null;
}
