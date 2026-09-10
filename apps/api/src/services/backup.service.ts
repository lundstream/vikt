import { spawn } from "node:child_process";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { adminLog, backupRuns, backupSettings } from "../db/schema.js";
import type { Env } from "../env.js";
import {
  decryptSecret,
  encryptSecret,
  readSecretKey,
  secretsAvailable,
  SECRET_USES,
} from "../lib/secrets.js";
import { connectSmb, explainSmbError, type SmbSession } from "../lib/backup-smb.js";

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
 * **Local and SMB are implemented; S3 is not.** S3 stays in the settings enum
 * because that is the column that would have to change, and the service refuses
 * it with a reason rather than pretending. See D103 for why that is a boundary
 * rather than an omission.
 *
 * The SMB destination speaks the protocol from Node rather than mounting the
 * share, because mounting inside a container needs `CAP_SYS_ADMIN` (D130). The
 * mounted path is still supported and is still the fallback: it is a `local`
 * destination pointed at a path the host happens to have mounted, and nothing
 * in `backup-smb.ts` is involved in it.
 *
 * **Encryption happens before the destination sees anything**, which is what
 * makes writing over SMB acceptable at all: what crosses the network is
 * ciphertext with a GCM tag, not a database.
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
  smbHost: string;
  smbShare: string;
  smbDomain: string;
  smbUsername: string;
  /**
   * Whether a password is stored and readable, never the password itself.
   *
   * The same shape the mail settings use: an admin screen has to be able to say
   * "a password is set" and "the stored password cannot be read with this key",
   * and neither of those needs the value. Nothing in this API returns it.
   */
  smbPasswordSet: boolean;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

/** What is stored, encrypted as one value, in `credentials_encrypted`. */
type SmbCredentials = { username: string; password: string };

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
  smbHost: "",
  smbShare: "",
  smbDomain: "",
  smbUsername: "",
  smbPasswordSet: false,
  updatedAt: null,
  updatedByEmail: null,
};

/**
 * Reads the stored credentials, or null if there are none or the key cannot
 * read them.
 *
 * The two cases are deliberately the same here and deliberately different to
 * the caller: `runBackup` says "the stored password cannot be read" rather than
 * connecting with an empty one and reporting a logon failure, which is the same
 * symptom with a much worse explanation.
 */
function readSmbCredentials(
  stored: string,
  env: NodeJS.ProcessEnv,
): SmbCredentials | null {
  if (stored === "") return null;
  const plain = decryptSecret(stored, SECRET_USES.backupDestination, env);
  if (plain === null) return null;

  try {
    const parsed = JSON.parse(plain) as Partial<SmbCredentials>;
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}

async function settingsRow(db: Db) {
  const [row] = await db
    .select()
    .from(backupSettings)
    .where(eq(backupSettings.id, SINGLETON))
    .limit(1);
  return row ?? null;
}

export async function readBackupSettings(
  db: Db,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<BackupSettings> {
  const row = await settingsRow(db);
  if (!row) return DEFAULTS;
  const credentials = readSmbCredentials(row.credentialsEncrypted, processEnv);

  return {
    destinationKind: row.destinationKind,
    destinationPath: row.destinationPath,
    scheduleMinute: row.scheduleMinute,
    retainDays: row.retainDays,
    smbHost: row.smbHost,
    smbShare: row.smbShare,
    smbDomain: row.smbDomain,
    smbUsername: credentials?.username ?? "",
    smbPasswordSet: credentials !== null && credentials.password !== "",
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
    smbHost?: string;
    smbShare?: string;
    smbDomain?: string;
    smbUsername?: string;
    /**
     * Absent leaves the stored password alone (D130).
     *
     * The screen never receives the password, so it cannot send it back, and a
     * form that submitted an empty field as "clear the password" would wipe it
     * every time somebody changed the retention window. Sending an empty string
     * explicitly is how it is cleared, which the screen offers as its own
     * control.
     */
    smbPassword?: string | null;
  },
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<
  { ok: true } | { ok: false; reason: "unsupported_destination" | "no_secret_key" }
> {
  if (input.destinationKind === "s3") {
    return { ok: false, reason: "unsupported_destination" };
  }

  const smb = input.destinationKind === "smb";

  /**
   * A password can only be stored if there is a key to store it under.
   *
   * Refused rather than stored in the clear, and refused rather than dropped
   * silently: a destination saved without its password is one that fails at
   * three in the morning with a logon error, which is the worst time and the
   * least informative message.
   */
  if (smb && !secretsAvailable(processEnv)) {
    return { ok: false, reason: "no_secret_key" };
  }

  const existing = await settingsRow(db);
  const stored = existing ? readSmbCredentials(existing.credentialsEncrypted, processEnv) : null;

  const password = input.smbPassword === undefined ? (stored?.password ?? "") : (input.smbPassword ?? "");
  const username = input.smbUsername?.trim() ?? stored?.username ?? "";

  const credentialsEncrypted = smb
    ? encryptSecret(
        JSON.stringify({ username, password } satisfies SmbCredentials),
        SECRET_USES.backupDestination,
        processEnv,
      )
    : // A local destination needs none, and keeping a share's password around
      // after somebody switched away from it is storing a secret for no
      // purpose anybody could name.
      "";

  const values = {
    id: SINGLETON,
    destinationKind: input.destinationKind,
    destinationPath: input.destinationPath.trim(),
    credentialsEncrypted,
    smbHost: smb ? (input.smbHost?.trim() ?? "") : "",
    smbShare: smb ? (input.smbShare?.trim() ?? "") : "",
    smbDomain: smb ? (input.smbDomain?.trim() ?? "") : "",
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
    /**
     * Where it goes, in a form somebody reading the log can recognise. The
     * password is not here and neither is anything derived from it; the
     * username is, because an audit entry that does not say which account was
     * configured is an audit entry about nothing.
     */
    subject: smb
      ? `\\\\${values.smbHost}\\${values.smbShare}${
          values.destinationPath === "" ? "" : `\\${values.destinationPath}`
        }`
      : values.destinationPath,
    detail: [
      values.destinationKind,
      values.scheduleMinute === null ? "no schedule" : `${values.scheduleMinute} min`,
      ...(smb ? [`as ${username || "(no username)"}`] : []),
    ].join(", "),
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

  if (settings.destinationKind === "s3") {
    return finish({
      ok: false,
      reason: 'destination "s3" is not implemented; local and smb are',
    });
  }
  if (!secretsAvailable(processEnv)) {
    return finish({
      ok: false,
      reason: "SECRET_KEY is not set, and a backup is not written unencrypted",
    });
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const fileName = `vikt-${stamp}.dump.enc`;

  try {
    const bytes = await writeBackup(db, settings, env, fileName, processEnv);
    return finish({ ok: true, fileName, bytes });
  } catch (error) {
    return finish({ ok: false, reason: (error as Error).message.slice(0, 500) });
  }
}

/**
 * The dump, to whichever destination is configured, then the prune.
 *
 * Split from `runBackup` so that the row-keeping and the writing are two things
 * rather than one long function with a branch in the middle. Both destinations
 * do the same three steps in the same order — open, stream, prune — and the
 * only difference is what "open" and "delete" mean.
 *
 * **A partial file is removed on the way out.** A truncated dump that stays on
 * the destination is worse than no dump: it has a plausible name, a plausible
 * size, and it cannot be restored. Its GCM tag would be missing, so it would
 * fail closed, but only for somebody who tried.
 */
async function writeBackup(
  db: Db,
  settings: BackupSettings,
  env: Env,
  fileName: string,
  processEnv: NodeJS.ProcessEnv,
): Promise<number> {
  if (settings.destinationKind === "smb") {
    const row = await settingsRow(db);
    const credentials = readSmbCredentials(row?.credentialsEncrypted ?? "", processEnv);
    if (credentials === null) {
      throw new Error(
        "The stored share password cannot be read. Either SECRET_KEY changed, or no " +
          "password has been saved for this destination.",
      );
    }

    let session: SmbSession | null = null;
    try {
      session = await connectSmb({
        host: settings.smbHost,
        share: settings.smbShare,
        domain: settings.smbDomain,
        username: credentials.username,
        password: credentials.password,
        folder: settings.destinationPath,
      });

      const out = await session.createWriteStream(fileName);
      const bytes = await dumpEncrypted(env.DATABASE_URL, out, processEnv);
      await pruneOverSmb(session, settings.retainDays);
      return bytes;
    } catch (error) {
      await session?.unlink(fileName).catch(() => {});
      throw new Error(explainSmbError(error));
    } finally {
      session?.close();
    }
  }

  if (settings.destinationPath.trim() === "") {
    throw new Error("no destination is configured");
  }

  const target = path.join(settings.destinationPath, fileName);
  try {
    await mkdir(settings.destinationPath, { recursive: true });
    const bytes = await dumpEncrypted(env.DATABASE_URL, createWriteStream(target), processEnv);
    await pruneOldBackups(settings.destinationPath, settings.retainDays);
    return bytes;
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
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
 *
 * **It takes a stream, not a path** (D130). A local file and a file on a share
 * are both a `Writable`, and the encryption, the header, the tag and the
 * pg_dump handling are identical for either — the only thing that differed was
 * how the stream was opened. The byte count is kept as the bytes go past rather
 * than read back with `stat`, because a destination that cannot be stat'ed
 * afterwards is exactly the case this was extended for.
 */
async function dumpEncrypted(
  databaseUrl: string,
  out: NodeJS.WritableStream,
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

  const header = Buffer.concat([Buffer.from("VIKTBK1"), iv]);
  out.write(header);
  let bytes = header.length;

  /**
   * Counted here rather than by `stat` afterwards.
   *
   * A share can be written to and then refuse to describe what is on it, and a
   * backup that succeeded but reports `null` bytes reads on the screen as one
   * that half worked. The count is what actually went through the cipher.
   */
  const counted = new PassThrough();
  counted.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });

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

  await pipeline(dump.stdout, cipher, counted, out, { end: false });
  await exited;

  // The tag goes on the end, after the ciphertext, and the file is only closed
  // once it is there: a file without its tag cannot be decrypted at all, which
  // is the correct outcome for a dump that was cut short.
  const tag = cipher.getAuthTag();
  await new Promise<void>((resolve, reject) => {
    out.end(tag, () => resolve());
    out.on("error", reject);
  });

  return bytes + tag.length;
}

/**
 * Deletes backups on the share that are older than the retention window.
 *
 * The local version's twin, and deliberately the same rule: by age rather than
 * by count, so a week the schedule did not run cannot silently shorten the
 * window that survives.
 *
 * A file whose modification time the share will not report is **left alone**.
 * Deleting on a guess is the one mistake here that cannot be undone, and a
 * destination filling up is a problem somebody can see and fix.
 */
async function pruneOverSmb(session: SmbSession, retainDays: number): Promise<void> {
  if (retainDays <= 0) return;
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;

  for (const entry of await session.list()) {
    if (!/^vikt-.*\.dump\.enc$/.test(entry)) continue;
    const mtime = await session.mtimeOf(entry);
    if (mtime !== null && mtime.getTime() < cutoff) {
      await session.unlink(entry).catch(() => {});
    }
  }
}

/**
 * Writes a small file to the destination and deletes it again (D130).
 *
 * The one thing an admin cannot find out any other way: whether the host, the
 * share, the folder, the username and the password are, together, a place this
 * process can write. Every one of those can be individually plausible and
 * collectively wrong, and the alternative to this button is discovering it from
 * a failed run at three in the morning.
 *
 * **It writes and deletes rather than only connecting.** A share that
 * authenticates and then refuses to accept a file is a real configuration, and
 * it is the one a connect-only check would call healthy.
 *
 * Logged either way, with what happened. A test that passes is worth recording
 * because it dates the last time the destination was known to work.
 */
export async function testBackupDestination(
  db: Db,
  actor: Actor,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; wrote: string } | { ok: false; reason: string }> {
  const settings = await readBackupSettings(db, processEnv);
  const name = `vikt-probe-${Date.now()}.tmp`;
  const payload = Buffer.from("vikt probe\n");

  const record = async (
    outcome: { ok: true; wrote: string } | { ok: false; reason: string },
  ) => {
    await db.insert(adminLog).values({
      actorId: actor.id,
      actorEmail: actor.email,
      action: "backup.test",
      subject: settings.destinationKind,
      detail: outcome.ok ? `wrote and removed ${outcome.wrote}` : outcome.reason.slice(0, 500),
    });
    return outcome;
  };

  if (settings.destinationKind === "s3") {
    return record({ ok: false, reason: 'destination "s3" is not implemented' });
  }

  if (settings.destinationKind === "smb") {
    const row = await settingsRow(db);
    const credentials = readSmbCredentials(row?.credentialsEncrypted ?? "", processEnv);
    if (credentials === null) {
      return record({
        ok: false,
        reason: "No share password is stored, or SECRET_KEY cannot read the one that is.",
      });
    }

    let session: SmbSession | null = null;
    try {
      session = await connectSmb({
        host: settings.smbHost,
        share: settings.smbShare,
        domain: settings.smbDomain,
        username: credentials.username,
        password: credentials.password,
        folder: settings.destinationPath,
      });

      const out = await session.createWriteStream(name);
      await new Promise<void>((resolve, reject) => {
        out.on("error", reject);
        out.end(payload, () => resolve());
      });
      await session.unlink(name);

      return record({ ok: true, wrote: name });
    } catch (error) {
      // Best effort: if the write landed and the delete is what failed, the
      // probe file must not be left behind on somebody's share.
      await session?.unlink(name).catch(() => {});
      return record({ ok: false, reason: explainSmbError(error) });
    } finally {
      session?.close();
    }
  }

  if (settings.destinationPath.trim() === "") {
    return record({ ok: false, reason: "No destination is configured." });
  }

  const target = path.join(settings.destinationPath, name);
  try {
    await mkdir(settings.destinationPath, { recursive: true });
    await writeFile(target, payload);
    await rm(target, { force: true });
    return record({ ok: true, wrote: name });
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    return record({ ok: false, reason: (error as Error).message.slice(0, 500) });
  }
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
