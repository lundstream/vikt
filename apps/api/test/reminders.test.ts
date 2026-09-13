import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { dailyLog, profiles, pushSubscriptions, reminderSends, users, weightLog } from "../src/db/schema.js";
import type { PushPayload, PushTarget, SendOutcome } from "../src/lib/push.js";
import {
  alreadyDone,
  claimDay,
  dueNow,
  insideWindow,
  payloadFor,
  runReminders,
  SEND_WINDOW_MINUTES,
} from "../src/services/reminder.service.js";

/**
 * The two reminders (D136).
 *
 * Four rules carry this feature, and every one of them is a way it could be
 * quietly wrong: the wrong hour for somebody in another timezone, a reminder
 * for something already done, two reminders for one day, and a reminder that
 * arrives at lunchtime for a phone that was off at seven.
 *
 * **The clock is always supplied.** Not one assertion here reads the machine's
 * time, because the suite runs under `TZ=UTC` in CI and at UTC+2 on the
 * workstation, and three tests have already been fixed for exactly that
 * difference. Every `now` below is an explicit instant.
 */

const KEYED = {
  VAPID_PUBLIC_KEY: "test-public",
  VAPID_PRIVATE_KEY: "test-private",
  VAPID_SUBJECT: "mailto:test@example.test",
} as const;

/** A push that records what it was asked to send instead of sending it. */
function recordingSend(outcome: SendOutcome = { status: "sent" }) {
  const calls: { target: PushTarget; payload: PushPayload }[] = [];
  const send = async (target: PushTarget, payload: PushPayload): Promise<SendOutcome> => {
    calls.push({ target, payload });
    return outcome;
  };
  return { calls, send };
}

describe("the send window", () => {
  /**
   * Open at the minute and for half an hour after, so a tick that lands a few
   * minutes late still sends.
   */
  it("opens at the time and closes half an hour later", () => {
    expect(insideWindow(420, 420)).toBe(true);
    expect(insideWindow(420 + SEND_WINDOW_MINUTES - 1, 420)).toBe(true);
  });

  /**
   * **Late is worse than never.** A phone that was off at 07:00 does not get
   * "dags att väga dig" at 11:00: by then it is not a reminder, it is an
   * interruption about something the morning has already settled.
   */
  it("is closed before the time and long after it", () => {
    expect(insideWindow(419, 420)).toBe(false);
    expect(insideWindow(420 + SEND_WINDOW_MINUTES, 420)).toBe(false);
    expect(insideWindow(11 * 60, 420)).toBe(false);
  });
});

describe("who is due", () => {
  const ctx = useTestApp(KEYED);

  async function withProfile(patch: Record<string, unknown>) {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(profiles).set(patch).where(eq(profiles.userId, user.userId));
    return user;
  }

  /**
   * The rule this feature lives or dies on: 07:00 means seven in the morning
   * **where the person is**.
   *
   * 05:00 UTC is 07:00 in Stockholm and 14:00 in Tokyo. The Stockholm account
   * is due and the Tokyo one is not, and neither answer has anything to do with
   * the server's own clock.
   */
  it("fires at the user's local time, not the server's", async () => {
    const { db } = ctx();
    const stockholm = await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420,
    });
    const tokyo = await withProfile({
      timezone: "Asia/Tokyo",
      remindWeigh: true,
      remindWeighMinute: 420,
    });

    // 05:00 UTC in July: 07:00 in Stockholm (UTC+2), 14:00 in Tokyo (UTC+9).
    const due = await dueNow(db, new Date("2026-07-01T05:00:00.000Z"));

    expect(due.map((entry) => entry.userId)).toEqual([stockholm.userId]);
    expect(due[0]!.localDate).toBe("2026-07-01");
    void tokyo;
  });

  /** And the same instant is the Tokyo account's morning twelve hours earlier. */
  it("fires for the other timezone at its own seven", async () => {
    const { db } = ctx();
    const tokyo = await withProfile({
      timezone: "Asia/Tokyo",
      remindWeigh: true,
      remindWeighMinute: 420,
    });

    // 22:00 UTC on the 30th is 07:00 on the 1st in Tokyo, which is also the
    // case that catches a `local_date` derived from the UTC instant.
    const due = await dueNow(db, new Date("2026-06-30T22:00:00.000Z"));

    expect(due.map((entry) => entry.userId)).toEqual([tokyo.userId]);
    expect(due[0]!.localDate).toBe("2026-07-01");
  });

  it("leaves out accounts that have not turned it on", async () => {
    const { db } = ctx();
    await withProfile({ timezone: "Europe/Stockholm", remindWeigh: false, remindDay: false });

    expect(await dueNow(db, new Date("2026-07-01T05:00:00.000Z"))).toEqual([]);
  });

  /** A reminder to somebody who cannot sign in has nowhere to go. */
  it("leaves out disabled accounts", async () => {
    const { db } = ctx();
    const user = await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420,
    });
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.userId));

    expect(await dueNow(db, new Date("2026-07-01T05:00:00.000Z"))).toEqual([]);
  });

  /** One bad row must not take the sweep down with it. */
  it("skips a profile with an unusable timezone and keeps going", async () => {
    const { db } = ctx();
    await withProfile({
      timezone: "Nowhere/Invalid",
      remindWeigh: true,
      remindWeighMinute: 420,
    });
    const good = await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420,
    });

    const due = await dueNow(db, new Date("2026-07-01T05:00:00.000Z"));
    expect(due.map((entry) => entry.userId)).toEqual([good.userId]);
  });

  /** Both can be due at once, and they are two separate claims. */
  it("can have both reminders due in the same minute", async () => {
    const { db } = ctx();
    await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420,
      remindDay: true,
      remindDayMinute: 420,
    });

    const due = await dueNow(db, new Date("2026-07-01T05:00:00.000Z"));
    expect(due.map((entry) => entry.kind).sort()).toEqual(["day", "weigh"]);
  });
});

/**
 * Weekday times and weekend times (D136, amended).
 *
 * Every instant here is a Wednesday, a Friday or a Saturday on purpose, and the
 * dates are named in comments, because a test that silently lands on the wrong
 * day of the week would pass for the wrong reason.
 */
describe("the weekend", () => {
  const ctx = useTestApp(KEYED);

  async function withProfile(patch: Record<string, unknown>) {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(profiles).set(patch).where(eq(profiles.userId, user.userId));
    return user;
  }

  /** A Saturday consults the weekend pair and not the weekday one. */
  it("uses the weekend time on a Saturday", async () => {
    const { db } = ctx();
    await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420, // 07:00 on a weekday
      remindWeighWeekend: true,
      remindWeighWeekendMinute: 540, // 09:00 at the weekend
    });

    // 2026-07-04 is a Saturday. 05:00 UTC is 07:00 in Stockholm: the weekday
    // time, which must not fire, because it is not a weekday.
    expect(await dueNow(db, new Date("2026-07-04T05:00:00.000Z"))).toEqual([]);

    // 07:00 UTC is 09:00 there, which is the weekend time.
    const due = await dueNow(db, new Date("2026-07-04T07:00:00.000Z"));
    expect(due).toEqual([{ userId: due[0]?.userId, kind: "weigh", localDate: "2026-07-04" }]);
  });

  /** And Sunday is the weekend too, which is worth one assertion of its own. */
  it("uses the weekend time on a Sunday", async () => {
    const { db } = ctx();
    await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420,
      remindWeighWeekend: true,
      remindWeighWeekendMinute: 540,
    });

    // 2026-07-05, a Sunday, at 09:00 in Stockholm.
    const due = await dueNow(db, new Date("2026-07-05T07:00:00.000Z"));
    expect(due.map((entry) => entry.localDate)).toEqual(["2026-07-05"]);
  });

  /**
   * Off at the weekend is a setting, not the absence of one.
   *
   * The reminder stays on for the working week; Saturday simply produces
   * nothing, which is the arrangement somebody sets up on purpose.
   */
  it("is silent at the weekend when only the weekday switch is on", async () => {
    const { db } = ctx();
    await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true,
      remindWeighMinute: 420,
      remindWeighWeekend: false,
      remindWeighWeekendMinute: 420,
    });

    // Saturday at 07:00 local: nothing.
    expect(await dueNow(db, new Date("2026-07-04T05:00:00.000Z"))).toEqual([]);

    // The following Monday at 07:00 local: there it is.
    const monday = await dueNow(db, new Date("2026-07-06T05:00:00.000Z"));
    expect(monday.map((entry) => entry.localDate)).toEqual(["2026-07-06"]);
  });

  /** The reverse: on at the weekend and off during the week. */
  it("is silent on a weekday when only the weekend switch is on", async () => {
    const { db } = ctx();
    await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: false,
      remindWeighMinute: 420,
      remindWeighWeekend: true,
      remindWeighWeekendMinute: 420,
    });

    // Wednesday: nothing. Saturday, same local time: due.
    expect(await dueNow(db, new Date("2026-07-01T05:00:00.000Z"))).toEqual([]);
    expect(await dueNow(db, new Date("2026-07-04T05:00:00.000Z"))).toHaveLength(1);
  });

  /**
   * The case the whole thing turns on: **Friday 23:30 on the server is already
   * Saturday in Stockholm**, and that account gets its Saturday time.
   *
   * The same instant is still Friday afternoon in Los Angeles, and that account
   * gets its weekday time. One instant, two answers, and neither of them is the
   * server's day of the week.
   */
  it("follows the user's day of the week, not the server's", async () => {
    const { db } = ctx();

    // Friday 2026-07-03 at 23:30 UTC. Saturday 01:30 in Stockholm, Friday
    // 16:30 in Los Angeles.
    const now = new Date("2026-07-03T23:30:00.000Z");

    const stockholm = await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: false, // off on weekdays
      remindWeighMinute: 90,
      remindWeighWeekend: true, // on at the weekend, 01:30
      remindWeighWeekendMinute: 90,
    });

    const losAngeles = await withProfile({
      timezone: "America/Los_Angeles",
      remindWeigh: true, // on on weekdays, 16:30
      remindWeighMinute: 990,
      remindWeighWeekend: false, // off at the weekend
      remindWeighWeekendMinute: 990,
    });

    const due = await dueNow(db, now);

    expect(
      due.find((entry) => entry.userId === stockholm.userId),
      "Stockholm is having Saturday and its weekend reminder is on",
    ).toEqual({ userId: stockholm.userId, kind: "weigh", localDate: "2026-07-04" });

    expect(
      due.find((entry) => entry.userId === losAngeles.userId),
      "Los Angeles is still having Friday and its weekday reminder is on",
    ).toEqual({ userId: losAngeles.userId, kind: "weigh", localDate: "2026-07-03" });
  });

  /**
   * The mirror image, so the test above cannot pass by reading the wrong pair
   * for both of them: swap the switches and neither account is due.
   */
  it("does not fire the wrong pair for either of them", async () => {
    const { db } = ctx();

    const now = new Date("2026-07-03T23:30:00.000Z");

    await withProfile({
      timezone: "Europe/Stockholm",
      remindWeigh: true, // weekday only, but it is Saturday there
      remindWeighMinute: 90,
      remindWeighWeekend: false,
      remindWeighWeekendMinute: 90,
    });
    await withProfile({
      timezone: "America/Los_Angeles",
      remindWeigh: false,
      remindWeighMinute: 990,
      remindWeighWeekend: true, // weekend only, but it is Friday there
      remindWeighWeekendMinute: 990,
    });

    expect(await dueNow(db, now)).toEqual([]);
  });

  /**
   * The skip rule and the never-twice rule are unchanged: they key on the local
   * date, and the local date is where the weekend came from in the first place.
   */
  it("still skips what is already done, and still sends once, at the weekend", async () => {
    const { app, db } = ctx();
    const user = await withProfile({
      timezone: "Europe/Stockholm",
      remindDay: false,
      remindDayWeekend: true,
      remindDayWeekendMinute: 1320, // 22:00 on a Saturday
    });

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: `https://push.example.test/${user.userId}`,
      p256dh: "key",
      auth: "auth",
    });

    // Saturday 2026-07-04 at 22:00 in Stockholm.
    const now = new Date("2026-07-04T20:00:00.000Z");

    const first = recordingSend();
    expect((await runReminders(db, app.config, now, first.send)).sent).toBe(1);
    expect(first.calls).toHaveLength(1);

    // A second sweep inside the same window sends nothing more.
    const second = recordingSend();
    const again = await runReminders(db, app.config, now, second.send);
    expect(second.calls).toEqual([]);
    expect(again.sent).toBe(0);

    // And the claim is filed under the Saturday the user was having.
    const [claim] = await db
      .select()
      .from(reminderSends)
      .where(eq(reminderSends.userId, user.userId));
    expect(claim?.localDate).toBe("2026-07-04");
  });

  /** A day already filled in is not reminded about, whatever day it is. */
  it("skips the weekend reminder when the day is already filled in", async () => {
    const { app, db } = ctx();
    const user = await withProfile({
      timezone: "Europe/Stockholm",
      remindDay: false,
      remindDayWeekend: true,
      remindDayWeekendMinute: 1320,
    });

    await db.insert(dailyLog).values({
      userId: user.userId,
      clientUuid: "33333333-3333-3333-3333-333333333333",
      localDate: "2026-07-04",
      loggedAt: new Date("2026-07-04T19:30:00.000Z"),
    });

    const recorder = recordingSend();
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-04T20:00:00.000Z"),
      recorder.send,
    );

    expect(recorder.calls).toEqual([]);
    expect(result.skipped).toBe(1);
  });
});

describe("the skip rules", () => {
  const ctx = useTestApp(KEYED);

  async function ready(kind: "weigh" | "day") {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db
      .update(profiles)
      .set({
        timezone: "Europe/Stockholm",
        ...(kind === "weigh"
          ? { remindWeigh: true, remindWeighMinute: 420 }
          : { remindDay: true, remindDayMinute: 420 }),
      })
      .where(eq(profiles.userId, user.userId));

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: `https://push.example.test/${user.userId}`,
      p256dh: "key",
      auth: "auth",
    });

    return user;
  }

  const NOW = new Date("2026-07-01T05:00:00.000Z"); // 07:00 in Stockholm
  const TODAY = "2026-07-01";

  /**
   * Somebody who weighed themselves at 06:40 has answered the question. The
   * reminder then is the app failing to notice, which is the difference
   * between a reminder and an alarm.
   */
  it("does not send the morning one when a weight is already logged", async () => {
    const { app, db } = ctx();
    const user = await ready("weigh");

    await db.insert(weightLog).values({
      userId: user.userId,
      clientUuid: "11111111-1111-1111-1111-111111111111",
      localDate: TODAY,
      loggedAt: new Date("2026-07-01T04:40:00.000Z"),
      weightKg: "84.2",
      source: "manual",
    });

    expect(await alreadyDone(user.userId, db, "weigh", TODAY)).toBe(true);

    const recorder = recordingSend();
    const result = await runReminders(db, app.config, NOW, recorder.send);

    expect(recorder.calls).toEqual([]);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("does not send the evening one when the day is already filled in", async () => {
    const { app, db } = ctx();
    const user = await ready("day");

    await db.insert(dailyLog).values({
      userId: user.userId,
      clientUuid: "22222222-2222-2222-2222-222222222222",
      localDate: TODAY,
      loggedAt: new Date("2026-07-01T04:30:00.000Z"),
    });

    const recorder = recordingSend();
    const result = await runReminders(db, app.config, NOW, recorder.send);

    expect(recorder.calls).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  /** And it does send when the thing has not happened. */
  it("sends when nothing has been logged", async () => {
    const { app, db } = ctx();
    await ready("weigh");

    const recorder = recordingSend();
    const result = await runReminders(db, app.config, NOW, recorder.send);

    expect(result.sent).toBe(1);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]!.payload.body).toBe("Dags att väga dig");
    expect(recorder.calls[0]!.payload.url).toBe("/app/?logga");
  });

  /**
   * Never twice for one day, and the unique index is what enforces it rather
   * than a check somebody could forget. A second sweep in the same window
   * claims nothing.
   */
  it("sends once however many times the sweep runs", async () => {
    const { app, db } = ctx();
    await ready("weigh");

    const recorder = recordingSend();
    await runReminders(db, app.config, NOW, recorder.send);
    await runReminders(db, app.config, NOW, recorder.send);
    await runReminders(db, app.config, new Date("2026-07-01T05:10:00.000Z"), recorder.send);

    expect(recorder.calls).toHaveLength(1);

    const claims = await db.select().from(reminderSends);
    expect(claims).toHaveLength(1);
  });

  /** A skipped day is claimed too, so it is not reconsidered every minute. */
  it("claims the day even when it skips", async () => {
    const { app, db } = ctx();
    const user = await ready("weigh");

    await db.insert(weightLog).values({
      userId: user.userId,
      clientUuid: "33333333-3333-3333-3333-333333333333",
      localDate: TODAY,
      loggedAt: NOW,
      weightKg: "84.2",
      source: "manual",
    });

    await runReminders(db, app.config, NOW, recordingSend().send);

    const claims = await db.select().from(reminderSends);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.localDate).toBe(TODAY);
  });

  /** Tomorrow is a different day and gets its own reminder. */
  it("sends again the next day", async () => {
    const { app, db } = ctx();
    await ready("weigh");

    const recorder = recordingSend();
    await runReminders(db, app.config, NOW, recorder.send);
    await runReminders(db, app.config, new Date("2026-07-02T05:00:00.000Z"), recorder.send);

    expect(recorder.calls).toHaveLength(2);
  });

  /** claimDay is the primitive, and it is honest about who won. */
  it("claims a day exactly once", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    expect(await claimDay(user.userId, db, "weigh", TODAY)).toBe(true);
    expect(await claimDay(user.userId, db, "weigh", TODAY)).toBe(false);
    expect(await claimDay(user.userId, db, "day", TODAY)).toBe(true);
  });
});

describe("a subscription the push service has thrown away", () => {
  const ctx = useTestApp(KEYED);

  /**
   * Removed on the **first** failure, not after a count. A 404 or 410 means the
   * browser discarded it, so every future run would retry a row that can only
   * fail.
   */
  it("is deleted rather than retried", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db
      .update(profiles)
      .set({ timezone: "Europe/Stockholm", remindWeigh: true, remindWeighMinute: 420 })
      .where(eq(profiles.userId, user.userId));

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: "https://push.example.test/gone",
      p256dh: "key",
      auth: "auth",
    });

    const recorder = recordingSend({ status: "gone", reason: "push service returned 410" });
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-01T05:00:00.000Z"),
      recorder.send,
    );

    expect(result.removed).toBe(1);
    expect(await db.select().from(pushSubscriptions)).toEqual([]);
  });

  /** A transient failure keeps the row: the next reminder tries again. */
  it("survives a failure that is not a rejection", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db
      .update(profiles)
      .set({ timezone: "Europe/Stockholm", remindWeigh: true, remindWeighMinute: 420 })
      .where(eq(profiles.userId, user.userId));

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: "https://push.example.test/flaky",
      p256dh: "key",
      auth: "auth",
    });

    const recorder = recordingSend({ status: "failed", reason: "push service returned 500" });
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-01T05:00:00.000Z"),
      recorder.send,
    );

    expect(result.removed).toBe(0);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
  });
});

describe("without VAPID keys", () => {
  const ctx = useTestApp();

  /** Push is absent, not degraded: the sweep does nothing at all. */
  it("sends nothing and touches nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db
      .update(profiles)
      .set({ timezone: "Europe/Stockholm", remindWeigh: true, remindWeighMinute: 420 })
      .where(eq(profiles.userId, user.userId));

    const recorder = recordingSend();
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-01T05:00:00.000Z"),
      recorder.send,
    );

    expect(result).toEqual({ considered: 0, sent: 0, skipped: 0, removed: 0, unauthorized: 0 });
    expect(recorder.calls).toEqual([]);
    expect(await db.select().from(reminderSends)).toEqual([]);
  });
});

describe("the notification copy", () => {
  /**
   * §5's register: no dashes, no exclamation marks, no guilt. "Dags att väga
   * dig" is a reminder; "Du har inte vägt dig idag!" is a telling-off, and §3
   * rules out a failure state.
   */
  it("says what to do and nothing about what was missed", () => {
    for (const kind of ["weigh", "day"] as const) {
      const payload = payloadFor(kind);
      expect(payload.body).not.toMatch(/[–—!]/);
      expect(payload.body).not.toMatch(/glömt|missat|inte/i);
    }

    expect(payloadFor("weigh").body).toBe("Dags att väga dig");
    expect(payloadFor("day").body).toBe("Dags att fylla i dagen");
  });

  /** A tap lands on the thing being asked for, not on the dashboard. */
  it("opens the screen the reminder is about", () => {
    expect(payloadFor("weigh").url).toBe("/app/?logga");
    expect(payloadFor("day").url).toBe("/app/dag");
  });
});
