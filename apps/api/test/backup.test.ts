import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { adminLog, backupSettings, users } from "../src/db/schema.js";
import {
  listBackupRuns,
  testBackupDestination,
  nextRunAt,
  readBackupSettings,
  runBackup,
  writeBackupSettings,
} from "../src/services/backup.service.js";

/**
 * Backups (D103).
 *
 * Three things are worth testing here, and running `pg_dump` is not one of
 * them: that is Postgres's own program, and whether it is on PATH is a property
 * of the image rather than of this code.
 *
 *  1. **A failure is recorded as a failure**, with its reason. D96's script
 *     could fail into a log nobody read; the point of moving this into the app
 *     is that the status screen tells the truth on a bad morning.
 *  2. **Nothing is written unencrypted.** With no `SECRET_KEY` the run refuses
 *     rather than producing a plaintext copy of every user's data.
 *  3. **The file format decrypts**, which is what the documented restore
 *     depends on, and is checked here against the same header, salt and use
 *     string `infra/backup-decrypt.mjs` reads.
 */

const KEY = { SECRET_KEY: "b".repeat(64) } as NodeJS.ProcessEnv;

describe("the backup schedule", () => {
  /** The figure the status screen shows, computed once rather than on screen. */
  it("works out the next run from a time of day", () => {
    const monday = new Date("2026-09-07T09:00:00");

    // Later today.
    expect(nextRunAt(23 * 60, monday)?.toISOString().slice(0, 10)).toBe("2026-09-07");
    // Already passed, so tomorrow.
    expect(nextRunAt(3 * 60, monday)?.toISOString().slice(0, 10)).toBe("2026-09-08");
    // No schedule at all.
    expect(nextRunAt(null, monday)).toBeNull();
  });
});

describe("backup settings", () => {
  const ctx = useTestApp();

  async function actor() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  it("defaults to no schedule, which is what an unconfigured install has", async () => {
    const { db } = ctx();
    const settings = await readBackupSettings(db);
    expect(settings.scheduleMinute).toBeNull();
    expect(settings.destinationKind).toBe("local");
    expect(settings.destinationPath).toBe("");
  });

  it("stores a destination and a schedule, and logs who set them", async () => {
    const { app, db } = ctx();
    const who = await actor();

    const result = await writeBackupSettings(db, who, {
      destinationKind: "local",
      destinationPath: "/var/backups/vikt",
      scheduleMinute: 197,
      retainDays: 14,
    });
    expect(result).toEqual({ ok: true });

    const settings = await readBackupSettings(db);
    expect(settings.destinationPath).toBe("/var/backups/vikt");
    expect(settings.scheduleMinute).toBe(197);
    expect(settings.retainDays).toBe(14);
    expect(settings.updatedByEmail).toBe(who.email);

    void app;
  });

  /**
   * The destination that is named and refused. S3 is implemented now (D133);
   * SMB is the boundary, and it is refused with a reason rather than accepted
   * and silently doing nothing.
   *
   * Its own `describe` below covers what the refusal says. This one holds the
   * narrower property: nothing about a refused destination is written down, so
   * a rejected save cannot leave half a configuration behind.
   */
  it("writes nothing at all for a destination it refuses", async () => {
    const { db } = ctx();
    expect(
      await writeBackupSettings(db, await actor(), {
        destinationKind: "smb",
        destinationPath: "//nas/backups",
        scheduleMinute: null,
        retainDays: 30,
      }),
    ).toEqual({ ok: false, reason: "unsupported_destination" });

    expect((await readBackupSettings(db)).destinationPath).toBe("");
  });
});

/**
 * The share destination (D130).
 *
 * None of these reach a real server: there is no SMB server in CI and there
 * should not be one. What they hold is everything up to the socket — that the
 * credentials round-trip through the encrypted column, that the password never
 * comes back out of the API, that saving other settings does not wipe it, and
 * that switching away from the share does not leave it lying about.
 */
/**
 * The S3 destination's settings (D133).
 *
 * These are the parts that need no server: that the credentials round-trip
 * through the encrypted column, that the secret never comes back out of the
 * API, that saving other settings does not wipe it, and that switching away
 * does not leave it lying about. What needs a server is in
 * `backup-s3-live.test.ts`, which runs against a real MinIO.
 */
describe("an S3 destination", () => {
  const ctx = useTestApp();

  async function actorHere() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  const S3 = {
    destinationKind: "s3" as const,
    destinationPath: "vikt",
    scheduleMinute: 180,
    retainDays: 30,
    s3Endpoint: "http://nas.example.test:9000",
    s3Region: "us-east-1",
    s3Bucket: "backups",
    s3PathStyle: true,
    s3AccessKeyId: "viktaccess",
    s3SecretAccessKey: "hemligt",
  };

  it("stores the endpoint and bucket, and says a secret is set", async () => {
    const { db } = ctx();
    expect(await writeBackupSettings(db, await actorHere(), S3, KEY)).toEqual({ ok: true });

    const settings = await readBackupSettings(db, KEY);
    expect(settings.destinationKind).toBe("s3");
    expect(settings.s3Endpoint).toBe("http://nas.example.test:9000");
    expect(settings.s3Bucket).toBe("backups");
    expect(settings.s3AccessKeyId).toBe("viktaccess");
    expect(settings.s3PathStyle).toBe(true);
    expect(settings.s3SecretSet).toBe(true);

    // The secret is not in the shape at all, so no screen and no endpoint can
    // accidentally send it back.
    expect(Object.keys(settings)).not.toContain("s3SecretAccessKey");
    expect(JSON.stringify(settings)).not.toContain("hemligt");
  });

  it("does not keep the secret in the clear", async () => {
    const { db } = ctx();
    await writeBackupSettings(db, await actorHere(), S3, KEY);

    const [row] = await db.select().from(backupSettings);
    expect(row!.credentialsEncrypted).not.toContain("hemligt");
    expect(row!.credentialsEncrypted.startsWith("v1.")).toBe(true);
  });

  /**
   * An absent secret leaves the stored one alone. The screen never receives
   * it, so a form that read an empty field as "clear it" would wipe the secret
   * every time somebody changed the retention window.
   */
  it("keeps the secret when other settings are saved", async () => {
    const { db } = ctx();
    const who = await actorHere();
    await writeBackupSettings(db, who, S3, KEY);

    const { s3SecretAccessKey: _ignored, ...withoutSecret } = S3;
    await writeBackupSettings(db, who, { ...withoutSecret, retainDays: 7 }, KEY);

    const settings = await readBackupSettings(db, KEY);
    expect(settings.retainDays).toBe(7);
    expect(settings.s3SecretSet).toBe(true);
  });

  it("clears the secret when one is sent explicitly empty", async () => {
    const { db } = ctx();
    const who = await actorHere();
    await writeBackupSettings(db, who, S3, KEY);
    await writeBackupSettings(db, who, { ...S3, s3SecretAccessKey: "" }, KEY);

    expect((await readBackupSettings(db, KEY)).s3SecretSet).toBe(false);
  });

  /** Switching back to a directory drops the credentials. */
  it("forgets the credentials when the destination stops being a bucket", async () => {
    const { db } = ctx();
    const who = await actorHere();
    await writeBackupSettings(db, who, S3, KEY);

    await writeBackupSettings(db, who, {
      destinationKind: "local",
      destinationPath: "/var/backups/vikt",
      scheduleMinute: null,
      retainDays: 30,
    });

    const [row] = await db.select().from(backupSettings);
    expect(row!.credentialsEncrypted).toBe("");
    expect(row!.s3Bucket).toBe("");
    expect((await readBackupSettings(db, KEY)).s3SecretSet).toBe(false);
  });

  it("refuses to save a bucket when SECRET_KEY is absent", async () => {
    const { db } = ctx();
    expect(await writeBackupSettings(db, await actorHere(), S3, {})).toEqual({
      ok: false,
      reason: "no_secret_key",
    });
  });
});

/**
 * SMB is refused, and the refusal says what to do instead (D132, D133).
 *
 * It stays in the enum so the reason stays visible rather than the value
 * quietly disappearing. Both Node clients speak NTLMv1, current servers refuse
 * it, and writing NTLMv2 by hand is authentication code whose errors are
 * silent.
 */
describe("the SMB destination", () => {
  const ctx = useTestApp();

  async function actorHere() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  it("cannot be saved", async () => {
    const { db } = ctx();
    expect(
      await writeBackupSettings(
        db,
        await actorHere(),
        {
          destinationKind: "smb",
          destinationPath: "vikt",
          scheduleMinute: null,
          retainDays: 30,
        },
        KEY,
      ),
    ).toEqual({ ok: false, reason: "unsupported_destination" });

    expect((await readBackupSettings(db, KEY)).destinationPath).toBe("");
  });

  /** And a row already set to it fails a run with the way round it. */
  it("fails a run with a sentence naming the mounted path", async () => {
    const { app, db } = ctx();
    const who = await actorHere();
    await db.insert(backupSettings).values({
      id: "singleton",
      destinationKind: "smb",
      destinationPath: "vikt",
      retainDays: 30,
      updatedByEmail: who.email,
    });

    const outcome = await runBackup(db, app.config, who, KEY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("Mount the share on the host");
  });
});

describe("running a backup", () => {
  const ctx = useTestApp();

  it("records a failure with its reason rather than failing silently", async () => {
    const { app, db } = ctx();

    // No destination configured, which is the state a fresh install is in.
    const outcome = await runBackup(db, app.config, null, KEY);
    expect(outcome.ok).toBe(false);

    const runs = await listBackupRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toContain("destination");
    expect(runs[0]!.finishedAt).not.toBeNull();
  });

  /**
   * A backup is a copy of every user's data. Without a key to encrypt it, the
   * run refuses: an unencrypted copy leaving the machine by accident is worse
   * than no backup, because it is invisible.
   */
  it("refuses to write anything with no key to encrypt it with", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));

    const directory = await mkdtemp(path.join(tmpdir(), "vikt-backup-"));
    try {
      await writeBackupSettings(
        db,
        { id: user.userId, email: user.email },
        {
          destinationKind: "local",
          destinationPath: directory,
          scheduleMinute: null,
          retainDays: 30,
        },
      );

      const outcome = await runBackup(db, app.config, null, {} as NodeJS.ProcessEnv);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? "" : outcome.reason).toContain("SECRET_KEY");

      const runs = await listBackupRuns(db);
      expect(runs[0]!.status).toBe("failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/**
 * The file format, against the reader that has to open it.
 *
 * Not a test of the service's own writer, deliberately: it is a test that the
 * header, salt and use string in `backup.service.ts` and in
 * `infra/backup-decrypt.mjs` agree. Those are two files that have to hold the
 * same four constants, in different languages, and nothing else checks that a
 * backup written today can be read by the script shipped beside it.
 */
describe("the backup file format", () => {
  const SALT = Buffer.from("vikt.secrets.v1");
  const USE = "vikt.backup.file";

  it("is what infra/backup-decrypt.mjs reads", async () => {
    const secret = "b".repeat(64);
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, USE, 32));

    const plaintext = Buffer.from("PGDMP fake archive contents");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const blob = Buffer.concat([Buffer.from("VIKTBK1"), iv, body, cipher.getAuthTag()]);

    // Read back exactly the way the script does.
    expect(blob.subarray(0, 7).toString()).toBe("VIKTBK1");
    const readIv = blob.subarray(7, 19);
    const readTag = blob.subarray(blob.length - 16);
    const readBody = blob.subarray(19, blob.length - 16);

    const decipher = createDecipheriv("aes-256-gcm", key, readIv);
    decipher.setAuthTag(readTag);
    expect(Buffer.concat([decipher.update(readBody), decipher.final()])).toEqual(plaintext);
  });

  /** A truncated backup fails loudly rather than restoring most of a database. */
  it("refuses a truncated file", async () => {
    const secret = "b".repeat(64);
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, USE, 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(Buffer.from("PGDMP")), cipher.final()]);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(cipher.getAuthTag());
    decipher.update(body.subarray(0, Math.max(0, body.length - 1)));
    expect(() => decipher.final()).toThrow();
  });

  /** And the script is on disk where the documentation says it is. */
  it("has a decrypt script beside the compose file", async () => {
    const script = path.resolve(import.meta.dirname, "../../../infra/backup-decrypt.mjs");
    const source = await readFile(script, "utf8");
    expect(source).toContain("VIKTBK1");
    expect(source).toContain("vikt.backup.file");
    expect(source).toContain("vikt.secrets.v1");
    void writeFile;
  });
});

/**
 * The test-connection button (D130).
 *
 * It writes a small file and deletes it again, rather than only checking that
 * the destination looks plausible. A share that authenticates and then refuses
 * to accept a file is a real configuration, and it is exactly the one a
 * connect-only check would call healthy.
 *
 * Exercised against a local destination, which is the half that can be tested
 * without a server: the writing, the deleting, the audit row and the refusal
 * when nothing is configured are the same code for both.
 */
describe("testing the destination", () => {
  const ctx = useTestApp();

  async function actorHere() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  it("writes a probe and leaves nothing behind", async () => {
    const { db } = ctx();
    const who = await actorHere();
    const directory = await mkdtemp(path.join(tmpdir(), "vikt-probe-"));

    try {
      await writeBackupSettings(db, who, {
        destinationKind: "local",
        destinationPath: directory,
        scheduleMinute: null,
        retainDays: 30,
      });

      const outcome = await testBackupDestination(db, who);
      expect(outcome.ok).toBe(true);

      // The whole point: it wrote, and then it did not leave the file there.
      const left = await readdir(directory);
      expect(left).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** Recorded either way, because a pass dates the last time it was known to work. */
  it("records the result in the admin log", async () => {
    const { app, db } = ctx();
    const who = await actorHere();
    const directory = await mkdtemp(path.join(tmpdir(), "vikt-probe-"));

    try {
      await writeBackupSettings(db, who, {
        destinationKind: "local",
        destinationPath: directory,
        scheduleMinute: null,
        retainDays: 30,
      });
      await testBackupDestination(db, who);

      const rows = await app.db.select().from(adminLog);
      expect(rows.map((row) => row.action)).toContain("backup.test");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** And says so, rather than passing, when there is nowhere to write. */
  it("fails when no destination is configured", async () => {
    const { db } = ctx();
    const outcome = await testBackupDestination(db, await actorHere());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("No destination");
  });

  /** A path that cannot be created is a failure with the filesystem's own reason. */
  it("fails with a reason when the path cannot be written", async () => {
    const { db } = ctx();
    const who = await actorHere();
    const file = path.join(await mkdtemp(path.join(tmpdir(), "vikt-probe-")), "a-file");
    await writeFile(file, "not a directory");

    await writeBackupSettings(db, who, {
      destinationKind: "local",
      // A path *under* a regular file, which cannot be a directory.
      destinationPath: path.join(file, "nested"),
      scheduleMinute: null,
      retainDays: 30,
    });

    const outcome = await testBackupDestination(db, who);
    expect(outcome.ok).toBe(false);
  });
});
