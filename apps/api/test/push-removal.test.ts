import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import webpush from "web-push";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { profiles, pushSubscriptions } from "../src/db/schema.js";
import { sendPush } from "../src/lib/push.js";
import { hostOf, runReminders } from "../src/services/reminder.service.js";

/**
 * What happens to a subscription the push service rejects (D136, amended).
 *
 * The service-level tests in `reminders.test.ts` drive `SendOutcome` directly,
 * which **assumes** the mapping: they show that `gone` deletes and `failed`
 * does not, and say nothing about which HTTP status is which. That was the one
 * decision in this area with no test behind it, and it is the decision that
 * decides whether a table fills with dead rows or whether a working phone is
 * dropped after one bad night.
 *
 * So both halves are here: the status to outcome mapping, and the removal that
 * follows from it, including the line an operator reads.
 */

const TARGET = {
  endpoint: "https://wns2-db5p.notify.windows.com/w/?token=abc",
  p256dh: "key",
  auth: "auth",
};

const PAYLOAD = { title: "Vikt", body: "Dags att väga dig", url: "/app/", tag: "vikt-weigh" };

/** A delivery that throws what `web-push` throws for a given status. */
function rejectsWith(statusCode: number) {
  return (async () => {
    throw new webpush.WebPushError(
      `push service returned ${statusCode}`,
      statusCode,
      {},
      "",
      TARGET.endpoint,
    );
  }) as unknown as typeof webpush.sendNotification;
}

describe("what the push service's answer means", () => {
  /**
   * 410 is the browser saying it threw the subscription away. It will never
   * work again, so the row goes on the first failure rather than after a count.
   */
  it("treats 410 as gone", async () => {
    const outcome = await sendPush(TARGET, PAYLOAD, rejectsWith(410));
    expect(outcome).toMatchObject({ status: "gone" });
  });

  it("treats 404 as gone", async () => {
    expect(await sendPush(TARGET, PAYLOAD, rejectsWith(404))).toMatchObject({ status: "gone" });
  });

  /**
   * 403 **keeps** the row (amended 2026-09-12).
   *
   * It is the push service refusing the signature this server made, and the
   * signature is made here: a mispasted key, a rotated pair or a
   * `VAPID_SUBJECT` that is not a `mailto:` produces 403 for every device at
   * once. Treating it as death turned one bad deploy into the silent deletion
   * of every subscription in the table.
   */
  it("treats 403 as a refused signature rather than a dead subscription", async () => {
    const outcome = await sendPush(TARGET, PAYLOAD, rejectsWith(403));
    expect(outcome).toMatchObject({ status: "unauthorized" });
    expect(outcome.status).not.toBe("gone");
  });

  /**
   * The other direction, and the one that matters more: a push service having
   * a bad ten minutes must not cost somebody their phone.
   */
  it("treats a transient 500 as a failure, not as gone", async () => {
    expect(await sendPush(TARGET, PAYLOAD, rejectsWith(500))).toMatchObject({ status: "failed" });
  });

  it("treats 429 and 503 as failures too", async () => {
    expect(await sendPush(TARGET, PAYLOAD, rejectsWith(429))).toMatchObject({ status: "failed" });
    expect(await sendPush(TARGET, PAYLOAD, rejectsWith(503))).toMatchObject({ status: "failed" });
  });

  it("treats a network error as a failure", async () => {
    const deliver = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof webpush.sendNotification;

    expect(await sendPush(TARGET, PAYLOAD, deliver)).toMatchObject({ status: "failed" });
  });

  /** The endpoint is a capability. Only its host is fit to log. */
  it("logs the host and not the token", () => {
    expect(hostOf(TARGET.endpoint)).toBe("wns2-db5p.notify.windows.com");
    expect(hostOf(TARGET.endpoint)).not.toContain("token");
    expect(hostOf("not a url")).toBe("unknown host");
  });
});

describe("what the sweep does about it", () => {
  const KEYED = {
    VAPID_PUBLIC_KEY: "test-public",
    VAPID_PRIVATE_KEY: "test-private",
    VAPID_SUBJECT: "mailto:test@example.test",
  } as const;

  const ctx = useTestApp(KEYED);

  async function accountDue() {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // The reminder, set directly: this file is about the removal rather than
    // about the settings screen.
    await db
      .update(profiles)
      .set({
        timezone: "Europe/Stockholm",
        remindWeigh: true,
        remindWeighMinute: 420,
        remindWeighWeekend: true,
        remindWeighWeekendMinute: 420,
      })
      .where(eq(profiles.userId, user.userId));

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: `https://wns2-db5p.notify.windows.com/w/?token=${user.userId}`,
      p256dh: "key",
      auth: "auth",
    });

    return user;
  }

  /** Wednesday 2026-07-01, 07:00 in Stockholm. */
  const NOW = new Date("2026-07-01T05:00:00.000Z");

  it("removes a rejected subscription and reports it once", async () => {
    const { app, db } = ctx();
    const user = await accountDue();

    const removed: { id: string; host: string; reason: string }[] = [];
    const result = await runReminders(
      db,
      app.config,
      NOW,
      async () => ({ status: "gone", reason: "push service returned 410" }),
      (device) => removed.push(device),
    );

    expect(result.removed).toBe(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]?.host).toBe("wns2-db5p.notify.windows.com");
    expect(removed[0]?.reason).toContain("410");

    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.userId)),
    ).toEqual([]);
  });

  /**
   * The case the mapping change exists for: one misconfigured deploy must not
   * empty the table.
   */
  it("keeps every row when the signature is refused, and counts it", async () => {
    const { app, db } = ctx();
    const user = await accountDue();

    const removed: unknown[] = [];
    const result = await runReminders(
      db,
      app.config,
      NOW,
      async () => ({ status: "unauthorized", reason: "push service returned 403" }),
      (device) => removed.push(device),
    );

    expect(result.unauthorized).toBe(1);
    expect(result.removed).toBe(0);
    // Nothing to log per device: the warning is written once per sweep.
    expect(removed).toEqual([]);
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.userId)),
    ).toHaveLength(1);
  });

  /**
   * And it stays one figure however many devices it happened to, which is what
   * lets the scheduler warn once rather than forty times.
   */
  it("counts one refusal per send, not one per sweep", async () => {
    const { app, db } = ctx();
    const user = await accountDue();

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: `https://fcm.googleapis.com/fcm/send/${user.userId}`,
      p256dh: "key",
      auth: "auth",
    });

    const result = await runReminders(db, app.config, NOW, async () => ({
      status: "unauthorized",
      reason: "push service returned 403",
    }));

    expect(result.unauthorized).toBe(2);
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.userId)),
    ).toHaveLength(2);
  });

  it("keeps the row and reports nothing when the failure is transient", async () => {
    const { app, db } = ctx();
    const user = await accountDue();

    const removed: unknown[] = [];
    const result = await runReminders(
      db,
      app.config,
      NOW,
      async () => ({ status: "failed", reason: "push service returned 500" }),
      (device) => removed.push(device),
    );

    expect(result.removed).toBe(0);
    expect(removed).toEqual([]);
    expect(
      await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.userId)),
    ).toHaveLength(1);
  });
});
