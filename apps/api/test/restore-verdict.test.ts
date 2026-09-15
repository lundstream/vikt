import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BACKUP_MAGIC, backupKey, decryptBackup } from "../src/lib/backup-file.js";
import {
  judgeRestore,
  restoreCheckAgeDays,
  restoreCheckDue,
  RESTORE_CHECK_EVERY_DAYS,
  RESTORE_CHECK_OLD_AFTER_DAYS,
  type DatabaseShape,
} from "../src/lib/restore-verdict.js";

/**
 * The restore check's rules (D168): reading the encrypted file, when a check is
 * due, and what counts as a restore that worked. The part that runs
 * `pg_restore` is exercised in the API image, because this workstation has no
 * PostgreSQL client and the no-skip rule allows exactly one CI-only file.
 */

const SECRET = "c".repeat(64);

function encrypt(archive: Buffer, secret = SECRET): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", backupKey(secret), iv);
  const body = Buffer.concat([cipher.update(archive), cipher.final()]);
  return Buffer.concat([Buffer.from(BACKUP_MAGIC), iv, body, cipher.getAuthTag()]);
}

describe("reading a backup file", () => {
  it("gives back the archive that was encrypted", () => {
    const archive = Buffer.from("PGDMP a pretend custom-format archive");
    expect(decryptBackup(encrypt(archive), SECRET)).toEqual({ ok: true, archive });
  });

  it("gives nothing for a file written under another key", () => {
    const blob = encrypt(Buffer.from("PGDMP"), "d".repeat(64));
    expect(decryptBackup(blob, SECRET)).toEqual({ ok: false, reason: "cannot_decrypt" });
  });

  it("gives nothing for a truncated file, rather than most of a database", () => {
    const blob = encrypt(Buffer.from("PGDMP ".repeat(100)));
    expect(decryptBackup(blob.subarray(0, blob.length - 5), SECRET)).toEqual({
      ok: false,
      reason: "cannot_decrypt",
    });
  });

  it("refuses a file that is not a Vikt backup at all", () => {
    expect(decryptBackup(Buffer.from("PGDMP plain dump, not encrypted, long enough"), SECRET)).toEqual({
      ok: false,
      reason: "not_a_backup",
    });
    expect(decryptBackup(Buffer.from("VIKT"), SECRET)).toEqual({ ok: false, reason: "not_a_backup" });
  });
});

describe("when a check is due", () => {
  const now = new Date("2026-09-16T03:30:00Z");
  const daysAgo = (days: number) => ({ startedAt: new Date(now.getTime() - days * 86_400_000) });

  it("is due when none has run", () => {
    expect(restoreCheckDue(null, now)).toBe(true);
  });

  it("is due at thirty days and not the day before", () => {
    expect(RESTORE_CHECK_EVERY_DAYS).toBe(30);
    expect(restoreCheckDue(daysAgo(29), now)).toBe(false);
    expect(restoreCheckDue(daysAgo(30), now)).toBe(true);
  });

  it("counts whole days for calling a check old, past thirty-five", () => {
    expect(RESTORE_CHECK_OLD_AFTER_DAYS).toBe(35);
    expect(restoreCheckAgeDays(daysAgo(35).startedAt, now)).toBe(35);
    expect(restoreCheckAgeDays(daysAgo(36).startedAt, now)).toBeGreaterThan(RESTORE_CHECK_OLD_AFTER_DAYS);
  });
});

describe("judging a restore", () => {
  const live: DatabaseShape = {
    tables: ["users", "weight_log", "food_entries"],
    rows: 500,
    migrations: 32,
    weightRows: 90,
  };

  it("accepts a restore with every table, fewer rows than live, and the same migrations", () => {
    expect(judgeRestore(live, { ...live, rows: 480, weightRows: 88 })).toEqual({ ok: true });
  });

  it("accepts a dump from before a deploy that added a migration", () => {
    expect(judgeRestore(live, { ...live, migrations: 31 })).toEqual({ ok: true });
  });

  it("refuses a missing table, and names it", () => {
    const verdict = judgeRestore(live, { ...live, tables: ["users", "weight_log"] });
    expect(verdict).toEqual({ ok: false, reason: expect.stringContaining("food_entries") });
  });

  it("refuses a dump newer than the running schema", () => {
    expect(judgeRestore(live, { ...live, migrations: 33 }).ok).toBe(false);
  });

  it("refuses the quiet failure: a schema with nothing in it", () => {
    expect(judgeRestore(live, { ...live, rows: 0, weightRows: 0 })).toEqual({
      ok: false,
      reason: "the restore has the schema and no rows at all",
    });
  });

  it("refuses a restore with no weight readings when the live database has some", () => {
    expect(judgeRestore(live, { ...live, weightRows: 0 }).ok).toBe(false);
  });

  it("refuses a database that records no migrations", () => {
    expect(judgeRestore(live, { ...live, migrations: 0 }).ok).toBe(false);
  });
});
