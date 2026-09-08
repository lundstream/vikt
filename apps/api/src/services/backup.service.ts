import { spawn } from "node:child_process";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { adminLog, backupRuns, backupSettings } from "../db/schema.js";
import type { Env } from "../env.js";
import { readSecretKey, secretsAvailable } from "../lib/secrets.js";

/**
 * Backups, run by the app and recorded (D103).
 *
 * ## What existed before this
 *
 * `infra/backup.sh` and `infra/restore-check.sh`, both written in the D96 pass,
 * both documented in `docs/backup.md`, and a restore that was genuinely
 * performed and compared against the live database. What was never done is the
 * one line that mattered: **the script was never installed in cron**. STATE.md
 * said so, under "do this next", where it sat for two passes.
 *
 * A backup script nobody scheduled produces no backups. So the schedule moves
 * into the app, where it can be seen, and every run leaves a row whether it
 * worked or not.
 *
 * ## What this does and does not do
 *
 * It runs `pg_dump -Fc`, encrypts the stream, and writes it to the destination.
 * **Only a local destination is implemented.** SMB and S3 are in the settings
 * enum because that is the column that would have to change, and the service
 * refuses them with a reason rather than pretending. See D103 for why that is a
 * boundary rather than an omission.
 *
 * Restore is deliberately **not** here and never a button. It is a documented
 * command in `docs/backup.md`, because the one operation that can destroy a
 * live database by succeeding should require somebody to type it.
 */

const SINGLETON = "singleton";

/** Its own use string, so a backup key cannot read the mail password. */
const BACKUP_USE = "vikt.backup.file";
const SALT = Buffer.from("vikt.secrets.v1");

export type BackupSettings = {
  destinationKind: "local" | "smb" | "s3";
  destinationPath: string;
  scheduleMinute: number | null;
  retainDays: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export type BackupRun = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  startedByEmail: string | null;
  destination: string;
  fileName: string | null;
  bytes: number | null;
  error: string | null;
};

export type Actor = { id: string; email: string };

const DEFAULTS: BackupSettings = {
  destinationKind: "local",
  destinationPath: "",
  scheduleMinute: null,
  retainDays: 30,
  updatedAt: null,
  updatedByEmail: null,
};

async function settingsRow(db: Db) {
  const [row] = await db
    .select()
    .from(backupSettings)
    .where(eq(backupSettings.id, SINGLETON))
    .limit(1);
  return row ?? null;
}

export async function readBackupSettings(db: Db): Promise<BackupSettings> {
  const row = await settingsRow(db);
  if (!row) return DEFAULTS;
  return {
    destinationKind: row.destinationKind,
    destinationPath: row.destinationPath,
    scheduleMinute: row.scheduleMinute,
    retainDays: row.retainDays,
    updatedAt: row.updatedAt.toISOString(),
    updatedByEmail: row.updatedByEmail,
  };
}

export async function writeBackupSettings(
  db: Db,
  actor: Actor,
  input: {
    destinationKind: "local" | "smb" | "s3";
    destinationPath: string;
    scheduleMinute: number | null;
    retainDays: number;
  },
): Promise<{ ok: true } | { ok: false; reason: "unsupported_destination" }> {
  if (input.destinationKind !== "local") {
    return { ok: false, reason: "unsupported_destination" };
  }

  const values = {
    id: SINGLETON,
    destinationKind: input.destinationKind,
    destinationPath: input.destinationPath.trim(),
    credentialsEncrypted: "",
    scheduleMinute: input.scheduleMinute,
    retainDays: input.retainDays,
    updatedAt: new Date(),
    updatedByEmail: actor.email,
  };

  await db
    .insert(backupSettings)
    .values(values)
    .onConflictDoUpdate({ target: backupSettings.id, set: values });

  await db.insert(adminLog).values({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "backup.configure",
    subject: values.destinationPath,
    detail: values.scheduleMinute === null ? "no schedule" : `${values.scheduleMinute} min`,
  });

  return { ok: true };
}

/** The most recent runs, newest first. */
export async function listBackupRuns(db: Db, limit = 20): Promise<BackupRun[]> {
  const rows = await db
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.startedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    status: row.status,
    startedByEmail: row.startedByEmail,
    destination: row.destination,
    fileName: row.fileName,
    bytes: row.bytes,
    error: row.error,
  }));
}

/**
 * When the next scheduled run is due, given the schedule and the clock.
 *
 * Returned rather than computed on the screen, because "next run" is the thing
 * an operator checks to know the schedule is real, and a figure derived in two
 * places is a figure that will disagree with itself.
 */
export function nextRunAt(scheduleMinute: number | null, now = new Date()): Date | null {
  if (scheduleMinute === null) return null;

  const next = new Date(now);
  next.setHours(0, scheduleMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

export type BackupOutcome =
  | { ok: true; fileName: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Runs one backup, start to finish, recording a row either way.
 *
 * The row is written **before** the work starts, so a crash mid-dump leaves a
 * `running` row rather than no evidence at all. A status screen showing a run
 * that started and never finished is telling the truth about what happened.
 */
export async function runBackup(
  db: Db,
  env: Env,
  actor: Actor | null,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<BackupOutcome> {
  const settings = await readBackupSettings(db);

  const [run] = await db
    .insert(backupRuns)
    .values({
      status: "running",
      startedByEmail: actor?.email ?? null,
      destination: settings.destinationPath,
    })
    .returning({ id: backupRuns.id });

  const finish = async (outcome: BackupOutcome): Promise<BackupOutcome> => {
    await db
      .update(backupRuns)
      .set({
        finishedAt: new Date(),
        status: outcome.ok ? "ok" : "failed",
        ...(outcome.ok ? { fileName: outcome.fileName, bytes: outcome.bytes } : { error: outcome.reason }),
      })
      .where(eq(backupRuns.id, run!.id));

    if (actor) {
      await db.insert(adminLog).values({
        actorId: actor.id,
        actorEmail: actor.email,
        action: "backup.run",
        subject: outcome.ok ? outcome.fileName : null,
        detail: outcome.ok ? `${outcome.bytes} bytes` : outcome.reason,
      });
    }
    return outcome;
  };

  if (settings.destinationKind !== "local") {
    return finish({
      ok: false,
      reason: `destination "${settings.destinationKind}" is not implemented, only local is`,
    });
  }
  if (settings.destinationPath.trim() === "") {
    return finish({ ok: false, reason: "no destination is configured" });
  }
  if (!secretsAvailable(processEnv)) {
    return finish({
      ok: false,
      reason: "SECRET_KEY is not set, and a backup is not written unencrypted",
    });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const fileName = `vikt-${stamp}.dump.enc`;
  const target = path.join(settings.destinationPath, fileName);

  try {
    await mkdir(settings.destinationPath, { recursive: true });
    const bytes = await dumpEncrypted(env.DATABASE_URL, target, processEnv);
    await pruneOldBackups(settings.destinationPath, settings.retainDays);
    return finish({ ok: true, fileName, bytes });
  } catch (error) {
    // A partial file is worse than none: it looks like a backup.
    await rm(target, { force: true }).catch(() => {});
    return finish({ ok: false, reason: (error as Error).message.slice(0, 500) });
  }
}

/**
 * `pg_dump -Fc`, encrypted on the way to disk.
 *
 * Encrypted **before it is written**, not after, so the plaintext dump never
 * exists as a file anywhere. That matters most for the case this is for: a
 * destination that is not the machine the database is on.
 *
 * The header is `VIKTBK1` plus the 12-byte IV, and the GCM tag is appended at
 * the end, which is what `infra/restore-check.sh` and the documented restore
 * command read. A stream cipher would have let the file be decrypted while it
 * was still being written; GCM's tag means the whole file is verified or none
 * of it is used, which is the right property for a backup.
 */
async function dumpEncrypted(
  databaseUrl: string,
  target: string,
  processEnv: NodeJS.ProcessEnv,
): Promise<number> {
  const secret = readSecretKey(processEnv);
  if (secret === null) throw new Error("SECRET_KEY is not set");
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, BACKUP_USE, 32));

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const dump = spawn("pg_dump", ["-Fc", "--no-owner", databaseUrl], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  dump.stderr.on("data", (chunk) => {
    stderr += String(chunk).slice(0, 2000);
  });

  const out = createWriteStream(target);
  out.write(Buffer.concat([Buffer.from("VIKTBK1"), iv]));

  const exited = new Promise<void>((resolve, reject) => {
    dump.on("error", (error) =>
      reject(
        new Error(
          `pg_dump could not be started (${error.message}). It has to be on PATH in the API image.`,
        ),
      ),
    );
    dump.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pg_dump exited ${code}: ${stderr.trim() || "no output"}`)),
    );
  });

  await pipeline(dump.stdout, cipher, out, { end: false });
  await exited;

  // The tag goes on the end, after the ciphertext, and the file is only closed
  // once it is there: a file without its tag cannot be decrypted at all, which
  // is the correct outcome for a dump that was cut short.
  await new Promise<void>((resolve, reject) => {
    out.end(cipher.getAuthTag(), () => resolve());
    out.on("error", reject);
  });

  return (await stat(target)).size;
}

/**
 * Deletes backups older than the retention window.
 *
 * By age rather than by count, so a week the schedule did not run cannot
 * silently shorten the window that survives. Same rule `infra/backup.sh` used,
 * kept deliberately: two mechanisms that disagree about retention would be
 * worse than either.
 */
async function pruneOldBackups(directory: string, retainDays: number): Promise<void> {
  if (retainDays <= 0) return;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;

  for (const entry of await readdir(directory)) {
    if (!/^vikt-.*\.dump\.enc$/.test(entry)) continue;
    const full = path.join(directory, entry);
    const info = await stat(full).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(full, { force: true });
  }
}

/** The newest finished backup on disk, for the download endpoint. */
export async function latestBackupFile(
  db: Db,
): Promise<{ path: string; fileName: string } | null> {
  const settings = await readBackupSettings(db);
  if (settings.destinationKind !== "local" || settings.destinationPath.trim() === "") return null;

  const [row] = await db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.status, "ok"))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1);

  if (!row?.fileName) return null;
  const full = path.join(settings.destinationPath, row.fileName);
  return (await stat(full).catch(() => null)) ? { path: full, fileName: row.fileName } : null;
}
