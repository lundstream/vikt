import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestApp } from "./harness.js";
import { outboundEmail, workerHeartbeat } from "../src/db/schema.js";
import { queueMail } from "../src/mail/queue.js";
import { inviteRequestedMail } from "../src/mail/templates.js";
import { drainOnce, readWorkerState, recordTick, MAIL_WORKER } from "../src/mail/drainer.js";
import type { Mailer, SendResult } from "../src/mail/sender.js";

/**
 * The drainer actually drains (D104).
 *
 * `mail-queue.test.ts` covers `drainMail` and has since D88. It passed the whole
 * time the queue was stuck, because the thing that was missing was not the
 * function: it was **anything calling it**. The drainer was a separate process,
 * there was no service for it in compose, and nobody ran it.
 *
 * So these test the layer above: that one pass of the drainer takes a message
 * from queued to sent, and that it leaves a heartbeat whether or not it had
 * anything to do. The heartbeat is the part that would have made the defect
 * visible in under a minute instead of an hour.
 */

function stubMailer(outcome: SendResult = { ok: true }): Mailer & { sent: string[] } {
  const mailer = {
    enabled: true,
    sent: [] as string[],
    async send(input: { to: string }): Promise<SendResult> {
      mailer.sent.push(input.to);
      return outcome;
    },
    async refresh(): Promise<void> {},
  };
  return mailer;
}

describe("one pass of the drainer", () => {
  const ctx = useTestApp();

  /**
   * The test the brief asked for, and the one whose absence let this ship: a
   * queued message is **sent**, not merely enqueued.
   */
  it("sends a queued message", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    const mailer = stubMailer();
    expect(await drainOnce(db, mailer)).toBe(1);
    expect(mailer.sent).toEqual(["someone@example.test"]);

    const [row] = await db.select().from(outboundEmail);
    expect(row!.status).toBe("sent");
    expect(row!.sentAt).not.toBeNull();
  });

  it("leaves a heartbeat, so an idle queue is distinguishable from a dead one", async () => {
    const { db } = ctx();
    expect(await readWorkerState(db)).toBeNull();

    await drainOnce(db, stubMailer());

    const state = await readWorkerState(db);
    expect(state).not.toBeNull();
    expect(new Date(state!.lastTickAt).getTime()).toBeGreaterThan(Date.now() - 10_000);
    expect(state!.lastError).toBeNull();
  });

  /** A tick with nothing to do still counts. That is the whole point of it. */
  it("ticks even when there is nothing in the queue", async () => {
    const { db } = ctx();
    expect(await drainOnce(db, stubMailer())).toBe(0);
    expect(await readWorkerState(db)).not.toBeNull();
  });

  it("counts what it has sent, across ticks", async () => {
    const { db } = ctx();
    await queueMail(db, "one@example.test", inviteRequestedMail());
    await drainOnce(db, stubMailer());

    await queueMail(db, "two@example.test", inviteRequestedMail());
    await drainOnce(db, stubMailer());

    expect((await readWorkerState(db))!.sentSinceStart).toBe(2);
  });

  /**
   * A failing tick records the reason rather than vanishing. §3's honesty rule
   * applies to the app's own failures, and this one is the difference between
   * "the queue is stuck" and "the queue is stuck because the host is wrong".
   */
  it("records a reason when a tick goes wrong", async () => {
    const { db } = ctx();
    await recordTick(db, 0, "getaddrinfo ENOTFOUND smtp.example.invalid");

    const state = await readWorkerState(db);
    expect(state!.lastError).toContain("ENOTFOUND");

    // And a good tick clears it, so nobody chases an error that has ended.
    await drainOnce(db, stubMailer());
    expect((await readWorkerState(db))!.lastError).toBeNull();
  });

  /** Mail off is a supported configuration, and the drainer still says it lives. */
  it("still ticks with mail unconfigured", async () => {
    const { db } = ctx();
    await queueMail(db, "someone@example.test", inviteRequestedMail());

    const disabled: Mailer = {
      enabled: false,
      send: async () => ({ ok: false, reason: "off", permanent: true }),
      refresh: async () => {},
    };

    expect(await drainOnce(db, disabled)).toBe(0);
    const [row] = await db.select().from(outboundEmail);
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);

    const [beat] = await db
      .select()
      .from(workerHeartbeat)
      .where(eq(workerHeartbeat.name, MAIL_WORKER));
    expect(beat).toBeTruthy();
  });
});

describe("what the admin screen is told about the queue", () => {
  const ctx = useTestApp();

  it("carries the worker state beside the messages", async () => {
    const { app, db } = ctx();
    const { createUser } = await import("./factories.js");
    const { auth } = await import("./factories.js");
    const { users } = await import("../src/db/schema.js");

    const admin = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));

    await queueMail(db, "someone@example.test", inviteRequestedMail());
    await drainOnce(db, stubMailer());

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/mail",
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mail).toHaveLength(1);
    expect(body.worker).not.toBeNull();
    expect(body.worker.sentSinceStart).toBe(1);
  });
});
