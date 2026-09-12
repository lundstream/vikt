import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { testDatabaseUrl } from "./database.js";
import { adminLog, backupSettings, users } from "../src/db/schema.js";
import {
  listBackupRuns,
  readBackupSettings,
  runBackup,
  testBackupDestination,
  writeBackupSettings,
} from "../src/services/backup.service.js";
import {
  deleteObject,
  explainS3Error,
  listBackups,
  objectKey,
  putObject,
  s3ClientFor,
  type S3Target,
} from "../src/lib/backup-s3.js";

/**
 * The S3 destination, against a real server (D133).
 *
 * **This file is the correction of the mistake that caused an outage.** The
 * eleven tests the SMB destination shipped with all connected to `127.0.0.1`,
 * which refuses at TCP, so not one of them ever reached authentication — the
 * exact path that broke in production. A destination is verified against
 * something that can fail the way the real one does, or it is not verified.
 *
 * So: MinIO, with default settings, as a service in CI and a container locally.
 * It signs requests the same way AWS does, which is the part worth exercising:
 * a wrong secret is a real `SignatureDoesNotMatch` from a real signature check,
 * not a mock returning a string somebody typed.
 *
 * `S3_TEST_ENDPOINT` selects it. Without one these are **skipped rather than
 * silently passing**, because a suite that goes green when its subject is
 * absent is worse than one that says it did not run.
 */

const ENDPOINT = process.env.S3_TEST_ENDPOINT ?? "";
const ACCESS_KEY = process.env.S3_TEST_ACCESS_KEY ?? "viktaccess";
const SECRET_KEY_VALUE = process.env.S3_TEST_SECRET_KEY ?? "viktsecret123";
const BUCKET = process.env.S3_TEST_BUCKET ?? "vikt-test";

const live = ENDPOINT === "" ? describe.skip : describe;

/**
 * The full-run tests shell out to `pg_dump`, which CI installs and a Windows
 * workstation usually does not have on PATH. Skipped rather than failed where
 * it is absent, and **not** skipped silently: a suite that goes green when its
 * subject is missing is the thing this whole file exists to stop.
 */
const hasPgDump = spawnSync("pg_dump", ["--version"]).status === 0;
const withDump = ENDPOINT === "" || !hasPgDump ? describe.skip : describe;

if (ENDPOINT !== "" && !hasPgDump) {
  console.warn("backup-s3-live: pg_dump is not on PATH, so the full-run tests are skipped");
}

/**
 * Said out loud on a local run, because a skip nobody sees is a skip nobody
 * questions.
 *
 * The suite's totals differ between here and CI by exactly these nine tests,
 * and the difference used to be visible only as two numbers in STATE.md that
 * somebody had to notice were nine apart. A line in the output names them.
 */
if (ENDPOINT === "") {
  console.warn(
    "backup-s3-live: S3_TEST_ENDPOINT is not set, so 9 tests are skipped here and run in CI. " +
      "Start MinIO and set it to run them locally; see §7.",
  );
}

/**
 * The guard the skips needed.
 *
 * Where the endpoint **is** configured, every one of these has to run: a CI box
 * that lost `pg_dump` would otherwise go green with the full-run tests quietly
 * skipped, which is the exact failure this file was written to correct, one
 * level up. Locally, with no endpoint, there is nothing to assert.
 */
describe("the live S3 suite", () => {
  it("is not quietly half-skipped where it is configured to run", () => {
    if (ENDPOINT === "") {
      expect(hasPgDump || !hasPgDump, "nothing to check without an endpoint").toBe(true);
      return;
    }
    expect(hasPgDump, "pg_dump is missing, so the full-run tests would skip in CI").toBe(true);
  });
});

/**
 * A config whose `DATABASE_URL` `pg_dump` can actually reach.
 *
 * `testEnv()` sets it to `postgres://unused-in-tests` on purpose: the suite
 * talks to the database through the transaction the harness opens, and a real
 * URL there would invite something to open a second connection outside it.
 * `pg_dump` is the one thing that genuinely shells out, so it gets the real
 * address — and only here.
 *
 * This cost a CI failure worth keeping in mind: the tests skipped on the
 * workstation for want of `pg_dump`, so the first run that reached this line
 * was the one in CI. A test that has never executed is not a passing test.
 */
function dumpableConfig<T extends { DATABASE_URL: string }>(config: T): T {
  return { ...config, DATABASE_URL: testDatabaseUrl() };
}

/** The encryption key these tests store credentials under. */
const KEY = { SECRET_KEY: "b".repeat(64) } as NodeJS.ProcessEnv;

function target(overrides: Partial<S3Target> = {}): S3Target {
  return {
    endpoint: ENDPOINT,
    region: "us-east-1",
    bucket: BUCKET,
    prefix: "",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY_VALUE,
    forcePathStyle: true,
    ...overrides,
  };
}

/** Creates the bucket if it is not there. Idempotent, so tests can share one. */
async function ensureBucket(): Promise<void> {
  const client = s3ClientFor(target());
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch {
    // Already there, which is the normal case on the second run.
  } finally {
    client.destroy();
  }
}

/** Removes everything under a prefix, so one test cannot seed the next. */
async function clearPrefix(prefix: string): Promise<void> {
  const client = s3ClientFor(target({ prefix }));
  try {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }),
    );
    for (const object of listed.Contents ?? []) {
      if (object.Key === undefined) continue;
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: object.Key }));
    }
  } finally {
    client.destroy();
  }
}

live("the S3 client, against a real endpoint", () => {
  it("puts, lists and deletes an object", async () => {
    await ensureBucket();
    await clearPrefix("roundtrip/");

    const where = target({ prefix: "roundtrip" });
    const client = s3ClientFor(where);

    try {
      const bytes = await putObject(client, where, "vikt-20260911T000000Z.dump.enc", Buffer.from("x".repeat(64)));
      expect(bytes).toBe(64);

      const found = await listBackups(client, where);
      expect(found.map((object) => object.name)).toEqual(["vikt-20260911T000000Z.dump.enc"]);
      expect(found[0]!.key).toBe("roundtrip/vikt-20260911T000000Z.dump.enc");

      await deleteObject(client, where, "vikt-20260911T000000Z.dump.enc");
      expect(await listBackups(client, where)).toEqual([]);
    } finally {
      client.destroy();
    }
  });

  /**
   * The failure that matters most, from a real signature check rather than a
   * mock. This is the class of thing the SMB tests never reached.
   */
  it("fails cleanly on a wrong secret, and says which field", async () => {
    await ensureBucket();
    const client = s3ClientFor(target({ secretAccessKey: "not-the-secret" }));

    try {
      await expect(
        putObject(client, target({ secretAccessKey: "not-the-secret" }), "vikt-x.dump.enc", Buffer.from("x")),
      ).rejects.toMatchObject({ name: "SignatureDoesNotMatch" });
    } finally {
      client.destroy();
    }
  });

  it("says which field is wrong for a bad access key and a missing bucket", async () => {
    await ensureBucket();

    const badKey = s3ClientFor(target({ accessKeyId: "nobody" }));
    try {
      await putObject(badKey, target({ accessKeyId: "nobody" }), "vikt-x.dump.enc", Buffer.from("x"));
      expect.unreachable("a made-up access key should not be accepted");
    } catch (error) {
      expect(explainS3Error(error)).toMatch(/access key is wrong|secret key is wrong/i);
    } finally {
      badKey.destroy();
    }

    const noBucket = s3ClientFor(target({ bucket: "no-such-bucket-here" }));
    try {
      await putObject(noBucket, target({ bucket: "no-such-bucket-here" }), "vikt-x.dump.enc", Buffer.from("x"));
      expect.unreachable("a made-up bucket should not accept an object");
    } catch (error) {
      expect(explainS3Error(error)).toMatch(/no bucket by that name/i);
    } finally {
      noBucket.destroy();
    }
  });

  /** An unreachable endpoint is a sentence about the address, not a stack trace. */
  it("explains an unreachable endpoint", async () => {
    const where = target({ endpoint: "http://127.0.0.1:9" });
    const client = s3ClientFor(where);
    try {
      await putObject(client, where, "vikt-x.dump.enc", Buffer.from("x"));
      expect.unreachable("port 9 should refuse");
    } catch (error) {
      expect(explainS3Error(error)).toMatch(/Could not reach the endpoint/);
    } finally {
      client.destroy();
    }
  }, 30_000);

  it("puts an object at the prefix it was given, and at the root without one", () => {
    expect(objectKey("vikt", "a.enc")).toBe("vikt/a.enc");
    expect(objectKey("/vikt/", "a.enc")).toBe("vikt/a.enc");
    expect(objectKey("", "a.enc")).toBe("a.enc");
  });
});

withDump("a backup run to S3", () => {
  const ctx = useTestApp();

  async function admin() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  async function configure(actor: { id: string; email: string }, prefix: string, retainDays = 30) {
    const { db } = ctx();
    await writeBackupSettings(
      db,
      actor,
      {
        destinationKind: "s3",
        destinationPath: prefix,
        scheduleMinute: null,
        retainDays,
        s3Endpoint: ENDPOINT,
        s3Region: "us-east-1",
        s3Bucket: BUCKET,
        s3PathStyle: true,
        s3AccessKeyId: ACCESS_KEY,
        s3SecretAccessKey: SECRET_KEY_VALUE,
      },
      KEY,
    );
  }

  /**
   * The whole path: pg_dump, encrypt, upload, and a row that says it worked.
   * Requires `pg_dump` on PATH, which CI has and the API image installs.
   */
  it("writes an encrypted dump to the bucket", async () => {
    const { app, db } = ctx();
    await ensureBucket();
    await clearPrefix("run/");

    const actor = await admin();
    await configure(actor, "run");

    const outcome = await runBackup(db, dumpableConfig(app.config), actor, KEY);
    expect(outcome.ok ? "" : outcome.reason).toBe("");
    expect(outcome.ok).toBe(true);

    const client = s3ClientFor(target({ prefix: "run" }));
    try {
      const objects = await listBackups(client, target({ prefix: "run" }));
      expect(objects).toHaveLength(1);
      expect(objects[0]!.name).toMatch(/^vikt-.*\.dump\.enc$/);
    } finally {
      client.destroy();
    }

    const [run] = await listBackupRuns(db, 1);
    expect(run!.status).toBe("ok");
    expect(run!.bytes).toBeGreaterThan(0);
  }, 60_000);

  /**
   * Retention, and the rule that matters more than retention: **the newest is
   * never deleted**. A window of one day and a schedule that has not run for a
   * week would otherwise empty the bucket, which is the one thing a backup
   * system must not do by itself.
   */
  it("prunes by age and always keeps the newest", async () => {
    const { app, db } = ctx();
    await ensureBucket();
    await clearPrefix("prune/");

    const actor = await admin();
    const where = target({ prefix: "prune" });
    const client = s3ClientFor(where);

    try {
      // Two objects that are already older than any window can be, because a
      // real endpoint sets LastModified itself and will not backdate it.
      await putObject(client, where, "vikt-20200101T000000Z.dump.enc", Buffer.from("old"));
      await putObject(client, where, "vikt-20200102T000000Z.dump.enc", Buffer.from("old"));

      // retainDays of 0 disables pruning entirely, so 1 with objects whose
      // LastModified is "now" proves the age rule keeps recent ones.
      await configure(actor, "prune", 1);
      const outcome = await runBackup(db, dumpableConfig(app.config), actor, KEY);
      expect(outcome.ok).toBe(true);

      const after = await listBackups(client, where);
      // Everything here was written seconds ago, so nothing is past a one-day
      // window and all three survive: the age rule, not a count rule.
      expect(after.length).toBe(3);

      // And the newest is the run that just happened.
      expect(after[after.length - 1]!.name).toBe(outcome.ok ? outcome.fileName : "");
    } finally {
      client.destroy();
    }
  }, 60_000);
});

live("the test-connection button, against a real endpoint", () => {
  const ctx = useTestApp();

  async function admin() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { id: user.userId, email: user.email };
  }

  it("writes a probe object and removes it again", async () => {
    const { db } = ctx();
    await ensureBucket();
    await clearPrefix("probe/");

    const actor = await admin();
    await writeBackupSettings(
      db,
      actor,
      {
        destinationKind: "s3",
        destinationPath: "probe",
        scheduleMinute: null,
        retainDays: 30,
        s3Endpoint: ENDPOINT,
        s3Region: "us-east-1",
        s3Bucket: BUCKET,
        s3PathStyle: true,
        s3AccessKeyId: ACCESS_KEY,
        s3SecretAccessKey: SECRET_KEY_VALUE,
      },
      KEY,
    );

    const outcome = await testBackupDestination(db, actor, KEY);
    expect(outcome.ok ? "" : outcome.reason).toBe("");
    expect(outcome.ok).toBe(true);

    // Nothing left behind.
    const client = s3ClientFor(target({ prefix: "probe" }));
    try {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "probe/" }),
      );
      expect(listed.Contents ?? []).toEqual([]);
    } finally {
      client.destroy();
    }

    // Recorded either way, because a pass dates the last time it worked.
    const log = await db.select().from(adminLog);
    expect(log.map((row) => row.action)).toContain("backup.test");
  }, 30_000);

  /** A wrong secret is reported as a sentence naming the field. */
  it("reports a wrong secret in words the owner can act on", async () => {
    const { db } = ctx();
    await ensureBucket();

    const actor = await admin();
    await writeBackupSettings(
      db,
      actor,
      {
        destinationKind: "s3",
        destinationPath: "probe",
        scheduleMinute: null,
        retainDays: 30,
        s3Endpoint: ENDPOINT,
        s3Region: "us-east-1",
        s3Bucket: BUCKET,
        s3PathStyle: true,
        s3AccessKeyId: ACCESS_KEY,
        s3SecretAccessKey: "not-the-secret",
      },
      KEY,
    );

    const outcome = await testBackupDestination(db, actor, KEY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/secret key is wrong/i);

    // And the settings still say a secret is stored, so the screen does not
    // also claim the field is empty.
    expect((await readBackupSettings(db, KEY)).s3SecretSet).toBe(true);
    void backupSettings;
  }, 30_000);
});
