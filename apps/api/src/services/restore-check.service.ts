import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { restoreChecks } from "../db/schema.js";
import type { Env } from "../env.js";
import { decryptBackup } from "../lib/backup-file.js";
import {
  judgeRestore,
  restoreCheckAgeDays,
  RESTORE_CHECK_OLD_AFTER_DAYS,
  type DatabaseShape,
} from "../lib/restore-verdict.js";
import { readSecretKey } from "../lib/secrets.js";
import { readBackupSettings } from "./backup.service.js";

/**
 * The restore check (D168): a backup is shown to restore, not assumed to.
 *
 * `infra/restore-check.sh` does this for a plain `pg_dump` by hand. The app's
 * own backups are encrypted, and until this nothing ever read one back. So:
 *
 * 1. the newest encrypted dump in the backup directory, or the file named;
 * 2. decrypted with `SECRET_KEY`, the GCM tag verified before anything is used;
 * 3. `pg_restore` into a **scratch database** with a generated name;
 * 4. judged against the live database by `judgeRestore`;
 * 5. the scratch database dropped, whatever happened;
 * 6. one `restore_checks` row, whatever happened.
 *
 * **It never touches the live database except to count it.** Putting a backup
 * back is still a command somebody types (docs/backup.md); this only proves the
 * command would have something to work with.
 *
 * It needs `pg_restore` on PATH, which the API image has beside `pg_dump`, and a
 * role that may `CREATE DATABASE` for the scratch copy, which production's is.
 * It opens its own connections rather than using the app's, because `CREATE
 * DATABASE` cannot run inside a transaction and a test's handle is one.
 */

export type RestoreCheckTrigger = "schedule" | "command";

export type RestoreCheckOutcome =
  | { ok: true; fileName: string; tables: number; rows: number; migrations: number }
  | { ok: false; fileName: string | null; reason: string };

export type RestoreCheckSummary = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  trigger: RestoreCheckTrigger;
  fileName: string | null;
  tables: number | null;
  rows: number | null;
  migrations: number | null;
  error: string | null;
  /** Whole days since it started. */
  ageDays: number;
  /** Older than the thirty-five days the screen calls old, in words. */
  old: boolean;
};

const BACKUP_FILE = /^vikt-.*\.dump\.enc$/;

/** The newest check, for the admin screen, or null before the first one. */
export async function latestRestoreCheck(
  db: Db,
  now: Date = new Date(),
): Promise<RestoreCheckSummary | null> {
  const [row] = await db
    .select()
    .from(restoreChecks)
    .orderBy(desc(restoreChecks.startedAt))
    .limit(1);
  if (!row) return null;

  const ageDays = restoreCheckAgeDays(row.startedAt, now);
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    status: row.status,
    trigger: row.trigger,
    fileName: row.fileName,
    tables: row.tables,
    rows: row.rows,
    migrations: row.migrations,
    error: row.error,
    ageDays,
    old: ageDays > RESTORE_CHECK_OLD_AFTER_DAYS,
  };
}

/** The same server, another database: the scratch copy's connection string. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** What a database holds, in the counts `judgeRestore` reads. */
async function shapeOf(client: postgres.Sql): Promise<DatabaseShape> {
  const tables = (
    await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`
  ).map((row) => row.table_name);

  let rows = 0;
  for (const table of tables) {
    const [counted] = await client.unsafe<{ count: number }[]>(
      `select count(*)::int as count from "${table.replace(/"/g, '""')}"`,
    );
    rows += counted?.count ?? 0;
  }

  const migrations = await client<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations`
    .then((result) => result[0]?.count ?? 0)
    .catch(() => 0);

  const weightRows = tables.includes("weight_log")
    ? ((await client<{ count: number }[]>`select count(*)::int as count from weight_log`)[0]?.count ?? 0)
    : 0;

  return { tables, rows, migrations, weightRows };
}

/** `pg_restore --no-owner` from memory into the scratch database. */
function restore(archive: Buffer, scratchUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pg_restore",
      ["--no-owner", "--no-acl", "--exit-on-error", `--dbname=${scratchUrl}`],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on("error", (error) =>
      reject(
        new Error(
          `pg_restore could not be started (${error.message}). It has to be on PATH, as it is in the API image.`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_restore exited ${code}: ${stderr.trim() || "no output"}`)),
    );

    child.stdin.on("error", () => {
      // A restore that fails early closes stdin under us; the exit code says why.
    });
    child.stdin.end(archive);
  });
}

export async function runRestoreCheck(
  db: Db,
  env: Env,
  input: {
    trigger: RestoreCheckTrigger;
    /** A path to read, from the command. */
    file?: string;
    /** A file in the backup directory, from the schedule, which just wrote it. */
    fileName?: string;
  },
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<RestoreCheckOutcome> {
  const [row] = await db
    .insert(restoreChecks)
    .values({ trigger: input.trigger, status: "running" })
    .returning({ id: restoreChecks.id });

  let fileName: string | null = null;

  const finish = async (
    outcome: RestoreCheckOutcome,
  ): Promise<RestoreCheckOutcome> => {
    await db
      .update(restoreChecks)
      .set({
        finishedAt: new Date(),
        status: outcome.ok ? "ok" : "failed",
        fileName: outcome.fileName,
        ...(outcome.ok
          ? { tables: outcome.tables, rows: outcome.rows, migrations: outcome.migrations }
          : { error: outcome.reason.slice(0, 1000) }),
      })
      .where(eq(restoreChecks.id, row!.id));
    return outcome;
  };

  /* ------------------------------------------------------------ the file -- */

  let filePath: string;
  if (input.file) {
    filePath = input.file;
  } else {
    const settings = await readBackupSettings(db, processEnv);
    if (settings.destinationKind !== "local") {
      return finish({
        ok: false,
        fileName: null,
        reason:
          "the restore check reads backups from a directory, and this installation's go to " +
          `${settings.destinationKind === "s3" ? "an S3 bucket" : "a destination that is not a directory"}. ` +
          "Download one and run the check on the file.",
      });
    }
    if (settings.destinationPath.trim() === "") {
      return finish({ ok: false, fileName: null, reason: "no backup directory is configured" });
    }

    let name = input.fileName;
    if (!name) {
      const candidates = (await readdir(settings.destinationPath).catch(() => [] as string[]))
        .filter((entry) => BACKUP_FILE.test(entry))
        .sort();
      name = candidates.at(-1);
    }
    if (!name) {
      return finish({ ok: false, fileName: null, reason: `no backup file in ${settings.destinationPath}` });
    }
    filePath = path.join(settings.destinationPath, name);
  }
  fileName = path.basename(filePath);

  /* --------------------------------------------------------- decrypting -- */

  const secret = readSecretKey(processEnv);
  if (secret === null) {
    return finish({ ok: false, fileName, reason: "SECRET_KEY is not set, so the backup cannot be read" });
  }

  const blob = await readFile(filePath).catch((error: Error) => error);
  if (blob instanceof Error) {
    return finish({ ok: false, fileName, reason: `the file could not be read: ${blob.message}` });
  }

  const decrypted = decryptBackup(blob, secret);
  if (!decrypted.ok) {
    return finish({
      ok: false,
      fileName,
      reason:
        decrypted.reason === "not_a_backup"
          ? "the file is not a Vikt backup"
          : "the file could not be decrypted: SECRET_KEY is not the key it was written with, or the file is altered or truncated",
    });
  }

  /* ----------------------------------------- restoring into a scratch copy -- */

  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const scratch = `vikt_restorecheck_${stamp}`;
  const scratchUrl = withDatabase(env.DATABASE_URL, scratch);
  const redact = (text: string) =>
    [env.DATABASE_URL, scratchUrl].reduce((out, secretText) => out.split(secretText).join("<database>"), text);

  const admin = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  let scratchClient: postgres.Sql | null = null;

  try {
    await admin.unsafe(`create database "${scratch}"`);
    await restore(decrypted.archive, scratchUrl);

    scratchClient = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    const [live, restored] = await Promise.all([shapeOf(admin), shapeOf(scratchClient)]);
    const verdict = judgeRestore(live, restored);

    return finish(
      verdict.ok
        ? {
            ok: true,
            fileName,
            tables: restored.tables.length,
            rows: restored.rows,
            migrations: restored.migrations,
          }
        : { ok: false, fileName, reason: verdict.reason },
    );
  } catch (error) {
    return finish({ ok: false, fileName, reason: redact((error as Error).message) });
  } finally {
    await scratchClient?.end().catch(() => {});
    await admin.unsafe(`drop database if exists "${scratch}" with (force)`).catch(() => {});
    await admin.end().catch(() => {});
  }
}
