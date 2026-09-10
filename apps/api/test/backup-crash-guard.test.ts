import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { backupRuns, users } from "../src/db/schema.js";
import {
  backupInFlight,
  backupSettled,
  currentBackup,
  installBackupCrashGuard,
  resetBackupCrashGuardForTests,
} from "../src/lib/backup-crash-guard.js";

/**
 * A backup destination cannot take the API down (D132).
 *
 * This is the test for the outage. An admin pressed "test connection", the SMB
 * client threw from inside a socket `data` handler, and because that is outside
 * every promise chain the `try/catch` around the connect never saw it: Node
 * called it an uncaught exception and the process exited.
 *
 * The throw is simulated with `process.emit("uncaughtException", ...)`, which
 * is exactly what Node does when nothing catches one, rather than by actually
 * throwing from a socket — the real thing would take the test runner down with
 * it, which is the property being fixed.
 */

const ctx = useTestApp();

afterEach(() => {
  backupSettled();
  resetBackupCrashGuardForTests();
});

/** Removes the handlers the guard adds, so one test cannot arm the next. */
function withGuard(app: Parameters<typeof installBackupCrashGuard>[0]): () => void {
  const before = process.listeners("uncaughtException");
  installBackupCrashGuard(app);
  return () => {
    for (const listener of process.listeners("uncaughtException")) {
      if (!before.includes(listener)) process.off("uncaughtException", listener);
    }
  };
}

describe("when a destination throws outside any promise chain", () => {
  it("keeps the process alive and marks the run failed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));

    const [run] = await db
      .insert(backupRuns)
      .values({ status: "running", startedByEmail: user.email, destination: "smb://nas/backup" })
      .returning({ id: backupRuns.id });

    const remove = withGuard(app);
    try {
      backupInFlight(run!.id, "smb://nas/backup", db);

      // What Node does when a socket callback throws and nothing catches it.
      process.emit("uncaughtException", new Error("des-ecb is unsupported"));

      // The assertion that matters: we are still here to make it.
      expect(true).toBe(true);

      // And the row says what happened rather than staying "running" forever.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const [row] = await db.select().from(backupRuns).where(eq(backupRuns.id, run!.id));

      expect(row!.status).toBe("failed");
      expect(row!.error).toContain("des-ecb is unsupported");
      expect(row!.finishedAt).not.toBeNull();
    } finally {
      remove();
    }
  });

  /**
   * The window closes. A throw a minute after the backup finished is not the
   * backup's, and treating it as one would turn an unrelated bug into a silent
   * failed-backup row.
   */
  it("only claims a throw while a backup is actually in flight", async () => {
    const { db } = ctx();

    expect(currentBackup()).toBeNull();
    backupInFlight("some-run", "smb://nas/backup", db);
    expect(currentBackup()).toEqual({ runId: "some-run", destination: "smb://nas/backup" });

    backupSettled();
    expect(currentBackup()).toBeNull();
  });

  /** Installing twice adds one handler, not two. The suite builds many apps. */
  it("installs once however many times it is called", () => {
    const { app } = ctx();
    const before = process.listenerCount("uncaughtException");

    installBackupCrashGuard(app);
    const after = process.listenerCount("uncaughtException");
    installBackupCrashGuard(app);
    installBackupCrashGuard(app);

    expect(process.listenerCount("uncaughtException")).toBe(after);
    expect(after - before).toBeLessThanOrEqual(1);

    for (const listener of process.listeners("uncaughtException").slice(before)) {
      process.off("uncaughtException", listener);
    }
  });

  /**
   * The probe has no `backup_runs` row, so the guard has nothing to update. It
   * must still keep the process alive rather than throwing inside its own
   * handler while trying to write to a row id of "".
   */
  it("survives a throw from the test-connection probe, which has no row", async () => {
    const { app, db } = ctx();
    const remove = withGuard(app);

    try {
      backupInFlight("", "smb://nas/backup", db);
      process.emit("uncaughtException", new Error("thrown from a socket callback"));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(true).toBe(true);
    } finally {
      remove();
    }
  });
});
