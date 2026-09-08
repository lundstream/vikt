import { describe, expect, it } from "vitest";
import { backoffMs, drainMail, MAX_ATTEMPTS, queueMail } from "../src/mail/queue.js";
import { outboundEmail } from "../src/db/schema.js";
import { useTestApp } from "./harness.js";
import { inviteRequestedMail } from "../src/mail/templates.js";
import type { Mailer, SendResult } from "../src/mail/sender.js";

/**
 * The outbound queue (D88).
 *
 * The property that matters is that **a failed send is never silent**. Every
 * outcome leaves a row an admin can read: sent with a time, retrying with a
 * reason, or given up on with the reason it gave up. §3's honesty rule applies
 * to the app's own failures as much as to the user's data.
 */

function stubMailer(outcomes: SendResult[]): Mailer & { calls: number } {
  let call = 0;
  const mailer = {
    enabled: true,
    calls: 0,
    async send(): Promise<SendResult> {
      mailer.calls += 1;
      return outcomes[Math.min(call++, outcomes.length - 1)]!;
    },
    /** A stub has nothing to re-read: its settings are the outcomes above. */
    async refresh(): Promise<void> {},
  };
  return mailer;
}

const OK: SendResult = { ok: true };
const TEMPORARY: SendResult = { ok: false, reason: "greylisted", permanent: false };
const PERMANENT: SendResult = { ok: false, reason: "no such mailbox", permanent: true };

/**
 * A moment just after the row was queued.
 *
 * These used to be `new Date("2026-09-06T10:00:00Z")`, a date chosen because it
 * was safely in the future on the day the file was written. On 6 September 2026
 * it stopped being in the future, `queueMail` began stamping `next_attempt_at`
 * later than the "now" the test passed in, and two tests started failing on a
 * change that had nothing to do with mail.
 *
 * What the tests are actually about is ordering: is a row due yet, and does a
 * backoff push it past the next drain. So the instant is derived rather than
 * written down, and the calendar cannot expire it.
 */
function justAfterQueueing(): Date {
  return new Date(Date.now() + 1000);
}

describe("draining the queue", () => {
  const ctx = useTestApp();

  it("sends what is due and records that it went", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    const result = await drainMail(db, stubMailer([OK]));

    expect(result).toEqual({ sent: 1, failed: 0, retried: 0 });
    const [row] = await db.select().from(outboundEmail);
    expect(row!.status).toBe("sent");
    expect(row!.sentAt).not.toBeNull();
    expect(row!.lastError).toBeNull();
  });

  /**
   * Kept rather than deleted on success, unlike the offline write queue. There
   * the server is the record of what was logged; here this row is the only
   * thing that can answer "did the reset mail go out".
   */
  it("keeps the row after sending", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());
    await drainMail(db, stubMailer([OK]));
    expect(await db.select().from(outboundEmail)).toHaveLength(1);
  });

  it("retries a temporary refusal, with the reason on the row", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    const now = justAfterQueueing();
    const result = await drainMail(db, stubMailer([TEMPORARY]), now);

    expect(result).toEqual({ sent: 0, failed: 0, retried: 1 });
    const [row] = await db.select().from(outboundEmail);
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBe("greylisted");
    // Backed off, so the next drain leaves it alone.
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("does not pick up a message that is not due yet", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    const now = justAfterQueueing();
    await drainMail(db, stubMailer([TEMPORARY]), now);

    const mailer = stubMailer([OK]);
    await drainMail(db, mailer, new Date(now.getTime() + 1000));
    expect(mailer.calls).toBe(0);
  });

  /**
   * SMTP says which is which: 5xx is permanent, and a mailbox that does not
   * exist will not exist in ten minutes.
   */
  it("gives up at once on a permanent refusal", async () => {
    const { db } = ctx();
    await queueMail(db, "nobody@example.test", inviteRequestedMail());

    const result = await drainMail(db, stubMailer([PERMANENT]));

    expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
    const [row] = await db.select().from(outboundEmail);
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toContain("mailbox");
  });

  it("gives up after enough temporary failures rather than retrying forever", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    let now = justAfterQueueing();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await drainMail(db, stubMailer([TEMPORARY]), now);
      now = new Date(now.getTime() + backoffMs(attempt) + 1000);
    }

    const [row] = await db.select().from(outboundEmail);
    expect(row!.attempts).toBe(MAX_ATTEMPTS);
    // Stopped, and visible in the admin list as stopped rather than pending.
    expect(row!.status).toBe("failed");
    expect(row!.nextAttemptAt).toBeNull();
  });

  /** Mail off is a supported configuration, not an error. */
  it("does nothing at all when mail is unconfigured", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    const disabled: Mailer = {
      enabled: false,
      refresh: async () => {},
      send: async () => ({ ok: false, reason: "off", permanent: true }),
    };
    const result = await drainMail(db, disabled);

    expect(result).toEqual({ sent: 0, failed: 0, retried: 0 });
    const [row] = await db.select().from(outboundEmail);
    // Left pending, so configuring SMTP later delivers the backlog.
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
  });
});

describe("the backoff", () => {
  it("doubles and then stops growing", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(20)).toBe(60 * 60_000);
  });
});
