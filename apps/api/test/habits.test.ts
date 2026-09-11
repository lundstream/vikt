import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { habits, profiles, pushSubscriptions } from "../src/db/schema.js";
import type { PushPayload, PushTarget, SendOutcome } from "../src/lib/push.js";
import { dueNow, runReminders } from "../src/services/reminder.service.js";

/**
 * The habit checklist (D137).
 *
 * What these are actually for, in order of how badly each would fail quietly:
 *
 *  - **isolation.** A habit name can be a medication schedule (D107), so a
 *    habit id from another account has to be a 404 and not a row;
 *  - **the two kinds of unanswered day.** Unticking writes `checked: false`,
 *    and a day with no row at all is unknown. The streak reads differently in
 *    the two cases, and nothing but a test will notice if they merge;
 *  - **deleting with and without history**, which is the one irreversible
 *    thing on this screen;
 *  - **the reminder**, which reuses the D136 foundation and must skip a habit
 *    already ticked.
 *
 * Every date is explicit. Nothing here reads a clock.
 */

const ctx = useTestApp();

const KEYED = {
  VAPID_PUBLIC_KEY: "test-public",
  VAPID_PRIVATE_KEY: "test-private",
  VAPID_SUBJECT: "mailto:test@example.test",
} as const;

type App = ReturnType<typeof ctx>["app"];
type User = Awaited<ReturnType<typeof createUser>>;

async function addHabit(app: App, user: User, name: string, icon?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/habits",
    headers: auth(user),
    payload: { name, ...(icon === undefined ? {} : { icon }) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ id: string; name: string; icon: string | null }>();
}

function tick(app: App, user: User, habitId: string, localDate: string, checked = true) {
  return app.inject({
    method: "POST",
    url: "/api/habit-check",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), habitId, localDate, checked },
  });
}

async function day(app: App, user: User, localDate: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/day?localDate=${localDate}`,
    headers: auth(user),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{
    habits: {
      id: string;
      name: string;
      checked: boolean;
      answered: boolean;
      streak: { days: number; basis: string; countingFrom: string | null };
    }[];
  }>().habits;
}

describe("writing the checklist", () => {
  it("creates, renames and reorders, and the order is what comes back", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const water = await addHabit(app, user, "Två liter vatten", "droppe");
    const pill = await addHabit(app, user, "Vitaminer", "tablett");

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/habits/${pill.id}`,
      headers: auth(user),
      payload: { name: "D-vitamin" },
    });
    expect(renamed.json<{ name: string }>().name).toBe("D-vitamin");

    const reordered = await app.inject({
      method: "POST",
      url: "/api/habits/reorder",
      headers: auth(user),
      payload: { ids: [pill.id, water.id] },
    });
    expect(reordered.json<{ habits: { id: string }[] }>().habits.map((h) => h.id)).toEqual([
      pill.id,
      water.id,
    ]);
  });

  /** An icon outside the closed set is refused rather than stored and blank. */
  it("refuses an icon it cannot draw", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/habits",
      headers: auth(user),
      payload: { name: "Kaffe", icon: "espresso" },
    });

    expect(response.statusCode).toBe(400);
  });

  /**
   * The list is bounded, and says so rather than quietly refusing. §3 has no
   * failure state, but a stated limit is not one.
   */
  it("says how full the list is when it is full", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (let index = 0; index < 20; index += 1) {
      await addHabit(app, user, `Vana ${index}`);
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/habits",
      headers: auth(user),
      payload: { name: "En till" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ message: string }>().message).toContain("20");
  });
});

describe("ticking", () => {
  it("ticks and unticks a past date, and the day being shown is the one that answers", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const habit = await addHabit(app, user, "Stretching");

    // Last Tuesday, not today. Backfilling is ordinary (D62).
    expect((await tick(app, user, habit.id, "2026-09-08")).statusCode).toBe(200);

    const tuesday = await day(app, user, "2026-09-08");
    expect(tuesday[0]).toMatchObject({ checked: true, answered: true });

    // A different day is untouched, and unanswered rather than unticked.
    const wednesday = await day(app, user, "2026-09-09");
    expect(wednesday[0]).toMatchObject({ checked: false, answered: false });

    const untick = await tick(app, user, habit.id, "2026-09-08", false);
    expect(untick.json<{ checked: boolean }>().checked).toBe(false);

    const after = await day(app, user, "2026-09-08");
    // Answered and not ticked: the row stays, because that is a different fact
    // from never having answered.
    expect(after[0]).toMatchObject({ checked: false, answered: true });
  });

  /** Two taps on one day are one answer that changed its mind, not two rows. */
  it("keeps one row per habit per day however many times it is tapped", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const habit = await addHabit(app, user, "Promenad");

    for (const checked of [true, false, true]) {
      expect((await tick(app, user, habit.id, "2026-09-10", checked)).statusCode).toBe(200);
    }

    const rows = await day(app, user, "2026-09-10");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ checked: true });
  });

  /**
   * The isolation rule, which here is not theoretical: "ta tabletten" is a
   * record of medication.
   */
  it("does not let one account tick another account's habit", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    const habit = await addHabit(app, theirs, "Ta tabletten");

    const response = await tick(app, mine, habit.id, "2026-09-10");
    expect(response.statusCode).toBe(404);

    // And it is not readable either.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/habits/${habit.id}`,
      headers: auth(mine),
      payload: { name: "Något annat" },
    });
    expect(patched.statusCode).toBe(404);

    const theirList = await app.inject({
      method: "GET",
      url: "/api/habits",
      headers: auth(theirs),
    });
    expect(theirList.json<{ habits: { name: string }[] }>().habits[0]?.name).toBe("Ta tabletten");
  });
});

describe("the streak, over the wire", () => {
  /** The grace day, on a day that was answered for another habit. */
  it("spends a grace day on a day that was answered without this tick", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const water = await addHabit(app, user, "Vatten");
    const pill = await addHabit(app, user, "Vitaminer");

    // Water on all three days; the pill missed on the 9th, which was answered
    // because the water was ticked that day.
    for (const date of ["2026-09-08", "2026-09-09", "2026-09-10"]) {
      await tick(app, user, water.id, date);
    }
    await tick(app, user, pill.id, "2026-09-08");
    await tick(app, user, pill.id, "2026-09-10");

    const rows = await day(app, user, "2026-09-10");
    const pillRow = rows.find((row) => row.id === pill.id);

    expect(pillRow?.streak.days).toBe(2);
    expect(pillRow?.streak.basis).toBe("from_first");
  });

  /** And a day nobody answered stops the count rather than spending it. */
  it("stops at a day nobody answered", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const habit = await addHabit(app, user, "Vatten");

    await tick(app, user, habit.id, "2026-09-07");
    await tick(app, user, habit.id, "2026-09-08");
    // The 9th is missing entirely.
    await tick(app, user, habit.id, "2026-09-10");

    const rows = await day(app, user, "2026-09-10");
    expect(rows[0]?.streak.days).toBe(1);
    expect(rows[0]?.streak.basis).toBe("gap");
    expect(rows[0]?.streak.countingFrom).toBe("2026-09-10");
  });
});

describe("removing a habit", () => {
  it("keeps the history by default, and the habit leaves the list", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const habit = await addHabit(app, user, "Vatten");
    await tick(app, user, habit.id, "2026-09-10");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/habits/${habit.id}`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(204);

    expect(await day(app, user, "2026-09-10")).toEqual([]);

    // Archived rather than deleted: the row is still there, naming the ticks.
    const [row] = await db.select().from(habits).where(eq(habits.id, habit.id));
    expect(row?.archivedAt).not.toBeNull();

    /**
     * And the tick is still in the export, under a habit that still has a name.
     * That is the whole reason the row is archived rather than deleted.
     */
    const exported = await app.inject({
      method: "GET",
      url: "/api/export/json",
      headers: auth(user),
    });
    expect(exported.statusCode).toBe(200);

    const body = exported.json<{ tables: Record<string, Record<string, unknown>[]> }>();
    expect(body.tables.habit_checks).toHaveLength(1);
    expect(body.tables.habits?.[0]).toMatchObject({ name: "Vatten" });
  });

  it("takes the history too when asked, and only then", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const habit = await addHabit(app, user, "Vatten");
    await tick(app, user, habit.id, "2026-09-10");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/habits/${habit.id}?history=remove`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(204);

    const rows = await db.select().from(habits).where(eq(habits.id, habit.id));
    expect(rows).toEqual([]);
  });

  it("is a miss rather than a delete when the habit is not this account's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    const habit = await addHabit(app, theirs, "Vatten");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/habits/${habit.id}?history=remove`,
      headers: auth(mine),
    });

    expect(response.statusCode).toBe(404);
    const rows = await db.select().from(habits).where(eq(habits.id, habit.id));
    expect(rows).toHaveLength(1);
  });
});

/**
 * The habit's own reminder, on the foundation D136 built. Nothing new was added
 * to that foundation, which is what these check: the same window, the same
 * two-time shape, the same skip and never-twice rules.
 */
describe("a habit's reminder", () => {
  const keyed = useTestApp(KEYED);

  /** A push that records what it was asked to send instead of sending it. */
  function recordingSend(outcome: SendOutcome = { status: "sent" }) {
    const calls: { target: PushTarget; payload: PushPayload }[] = [];
    const send = async (target: PushTarget, payload: PushPayload): Promise<SendOutcome> => {
      calls.push({ target, payload });
      return outcome;
    };
    return { calls, send };
  }

  async function readyHabit(times: {
    remind?: boolean;
    remindMinute?: number;
    remindWeekend?: boolean;
    remindWeekendMinute?: number;
  }) {
    const { app, db } = keyed();
    const user = await createUser(app, db);
    await db
      .update(profiles)
      .set({ timezone: "Europe/Stockholm" })
      .where(eq(profiles.userId, user.userId));

    const habit = await addHabit(app, user, "Vitaminer");
    await app.inject({
      method: "PATCH",
      url: `/api/habits/${habit.id}`,
      headers: auth(user),
      payload: times,
    });

    await db.insert(pushSubscriptions).values({
      userId: user.userId,
      endpoint: `https://push.example.test/${user.userId}`,
      p256dh: "key",
      auth: "auth",
    });

    return { user, habit };
  }

  it("is due at its own time, in the user's timezone", async () => {
    const { db } = keyed();
    const { user, habit } = await readyHabit({ remind: true, remindMinute: 480 });

    // Wednesday 2026-07-01, 08:00 in Stockholm.
    const due = await dueNow(db, new Date("2026-07-01T06:00:00.000Z"));
    expect(due.find((entry) => entry.userId === user.userId)).toMatchObject({
      kind: `habit:${habit.id}`,
      localDate: "2026-07-01",
      habitName: "Vitaminer",
    });

    // An hour later the window has closed.
    expect(await dueNow(db, new Date("2026-07-01T07:00:00.000Z"))).toEqual([]);
  });

  /** The weekend pair, inherited from D136 rather than reinvented. */
  it("uses the weekend time on a Saturday and the weekday one otherwise", async () => {
    const { db } = keyed();
    await readyHabit({
      remind: true,
      remindMinute: 480, // 08:00 on a weekday
      remindWeekend: true,
      remindWeekendMinute: 660, // 11:00 at the weekend
    });

    // Saturday 2026-07-04 at 08:00 local: the weekday time, which does not fire.
    expect(await dueNow(db, new Date("2026-07-04T06:00:00.000Z"))).toEqual([]);
    // At 11:00 local on the same Saturday it does.
    expect(await dueNow(db, new Date("2026-07-04T09:00:00.000Z"))).toHaveLength(1);
    // And the weekday time still fires on the Wednesday.
    expect(await dueNow(db, new Date("2026-07-01T06:00:00.000Z"))).toHaveLength(1);
  });

  it("is off at the weekend when only the weekday switch is on", async () => {
    const { db } = keyed();
    await readyHabit({ remind: true, remindMinute: 480, remindWeekend: false });

    expect(await dueNow(db, new Date("2026-07-04T06:00:00.000Z"))).toEqual([]);
    expect(await dueNow(db, new Date("2026-07-01T06:00:00.000Z"))).toHaveLength(1);
  });

  /** Already ticked is already answered, and asking again is not a reminder. */
  it("is skipped when the habit is already ticked that day", async () => {
    const { app, db } = keyed();
    const { user, habit } = await readyHabit({ remind: true, remindMinute: 480 });
    await tick(app, user, habit.id, "2026-07-01");

    const recorder = recordingSend();
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-01T06:00:00.000Z"),
      recorder.send,
    );

    expect(recorder.calls).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(0);
  });

  /** Unticked is not done: the row exists, and the reminder still goes. */
  it("still sends when the day was answered with no tick", async () => {
    const { app, db } = keyed();
    const { user, habit } = await readyHabit({ remind: true, remindMinute: 480 });
    await tick(app, user, habit.id, "2026-07-01", false);

    const recorder = recordingSend();
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-01T06:00:00.000Z"),
      recorder.send,
    );

    expect(result.sent).toBe(1);
    expect(recorder.calls[0]?.payload.body).toBe("Kom ihåg: Vitaminer");
    expect(recorder.calls[0]?.payload.url).toBe("/app/dag");
  });

  it("sends once however many times the sweep runs", async () => {
    const { app, db } = keyed();
    await readyHabit({ remind: true, remindMinute: 480 });
    const now = new Date("2026-07-01T06:00:00.000Z");

    const first = recordingSend();
    expect((await runReminders(db, app.config, now, first.send)).sent).toBe(1);

    const second = recordingSend();
    expect((await runReminders(db, app.config, now, second.send)).sent).toBe(0);
    expect(second.calls).toEqual([]);
  });

  /**
   * Two habits at the same minute are two notifications, not one replacing the
   * other: the claim is per habit, and so is the tag.
   */
  it("keeps two habits at the same time apart", async () => {
    const { app, db } = keyed();
    const { user } = await readyHabit({ remind: true, remindMinute: 480 });

    const second = await addHabit(app, user, "Stretching");
    await app.inject({
      method: "PATCH",
      url: `/api/habits/${second.id}`,
      headers: auth(user),
      payload: { remind: true, remindMinute: 480 },
    });

    const recorder = recordingSend();
    const result = await runReminders(
      db,
      app.config,
      new Date("2026-07-01T06:00:00.000Z"),
      recorder.send,
    );

    expect(result.sent).toBe(2);
    expect(new Set(recorder.calls.map((call) => call.payload.tag)).size).toBe(2);
  });

  /** An archived habit is off the list, so it stops reminding. */
  it("stops reminding once the habit is removed", async () => {
    const { app, db } = keyed();
    const { user, habit } = await readyHabit({ remind: true, remindMinute: 480 });

    await app.inject({
      method: "DELETE",
      url: `/api/habits/${habit.id}`,
      headers: auth(user),
    });

    expect(await dueNow(db, new Date("2026-07-01T06:00:00.000Z"))).toEqual([]);
  });
});
