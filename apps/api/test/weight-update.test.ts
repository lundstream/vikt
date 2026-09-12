import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * Editing a reading is not logging a new one (D150).
 *
 * The defect this file exists for: editing 24 August from 110,0 to 110,1
 * through the calendar enqueued a **create** with a fresh `clientUuid`. The
 * server saw a queued write for a day another uuid already held, applied D41's
 * rule exactly as written, and reported "two devices wrote this day" about one
 * device editing its own reading. The queued row's "Försök igen" could never
 * succeed, because sending the identical bytes to the identical rule gets the
 * identical answer.
 *
 * The request could not say what it was. So it says now: a create is a create,
 * and an update carries the row's id and **the value the client had on screen**
 * when it opened. The server applies it while the row still holds that value
 * and asks only when it does not.
 */

const ctx = useTestApp();

type Entry = { id: string; weightKg: number; localDate: string; clientUuid: string };

const post = (
  app: ReturnType<typeof ctx>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
  payload: Record<string, unknown>,
) => app.inject({ method: "POST", url: "/api/weight", headers: auth(user), payload });

const put = (
  app: ReturnType<typeof ctx>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
  id: string,
  payload: Record<string, unknown>,
) =>
  app.inject({ method: "PUT", url: `/api/weight/${id}`, headers: auth(user), payload });

async function logOne(
  app: ReturnType<typeof ctx>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
  weightKg: number,
  day = localDate(),
): Promise<Entry> {
  const response = await post(app, user, {
    clientUuid: randomUUID(),
    localDate: day,
    weightKg,
  });
  expect(response.statusCode).toBe(200);
  return response.json<Entry>();
}

async function readings(
  app: ReturnType<typeof ctx>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
): Promise<Entry[]> {
  const list = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
  return list.json<{ entries: Entry[] }>().entries;
}

describe("editing a reading", () => {
  /** The 24 August case, as an online edit. It simply goes through. */
  it("applies when the row still holds what the client saw", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate(-20);
    const entry = await logOne(app, user, 110.0, day);

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: day,
      baselineWeightKg: 110.0,
      weightKg: 110.1,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Entry>().weightKg).toBe(110.1);

    const rows = await readings(app, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weightKg).toBe(110.1);
  });

  /**
   * The same edit, replayed out of the queue. `fromQueue` does **not** make it
   * a conflict: an edit arriving late against an unchanged row is the edit
   * arriving late, not a collision. This is the assertion the old model could
   * not make, because a queued create for an occupied day is a collision by
   * definition.
   */
  it("applies from the queue too, when nothing moved under it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate(-20);
    const entry = await logOne(app, user, 110.0, day);

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: day,
      baselineWeightKg: 110.0,
      weightKg: 110.1,
      fromQueue: true,
    });

    expect(response.statusCode).toBe(200);
    expect(await readings(app, user)).toHaveLength(1);
  });

  /** Stored as `numeric`, so "110.00" and 110 are the same reading. */
  it("does not call a trailing zero a conflict", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate(-20);
    const entry = await logOne(app, user, 110, day);

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: day,
      baselineWeightKg: 110.0,
      weightKg: 109.4,
    });

    expect(response.statusCode).toBe(200);
  });

  /**
   * The one case worth asking about: the row is not what the client was
   * looking at, so applying the edit would throw away a number somebody else
   * chose. The refusal carries what is stored, so the client can show both.
   */
  it("refuses when the row changed under the edit, and says what it holds", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate(-20);
    const entry = await logOne(app, user, 110.0, day);

    // Another device replaces the day in the meantime, live.
    await post(app, user, { clientUuid: randomUUID(), localDate: day, weightKg: 108.2 });

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: day,
      baselineWeightKg: 110.0,
      weightKg: 110.1,
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: string; existing: { weightKg: number } }>();
    expect(body.error).toBe("changed_since");
    expect(body.existing.weightKg).toBe(108.2);
  });

  it("says the row is gone rather than recreating it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const entry = await logOne(app, user, 110.0, localDate(-20));

    await app.inject({
      method: "DELETE",
      url: `/api/weight/${entry.id}`,
      headers: auth(user),
    });

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: localDate(-20),
      baselineWeightKg: 110.0,
      weightKg: 110.1,
    });

    expect(response.statusCode).toBe(404);
    expect(await readings(app, user)).toHaveLength(0);
  });

  /** Scoped by user id as well as row id, like every other write (§3). */
  it("cannot edit someone else's reading", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    const entry = await logOne(app, mine, 110.0, localDate(-20));

    const response = await put(app, theirs, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: localDate(-20),
      baselineWeightKg: 110.0,
      weightKg: 90,
    });

    expect(response.statusCode).toBe(404);
    expect((await readings(app, mine))[0]?.weightKg).toBe(110);
  });
});

describe("moving a reading to another day", () => {
  it("moves it when the day is free", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const entry = await logOne(app, user, 110.0, localDate(-20));

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: localDate(-19),
      baselineWeightKg: 110.0,
      weightKg: 110.0,
    });

    expect(response.statusCode).toBe(200);
    const rows = await readings(app, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.localDate).toBe(localDate(-19));
  });

  /**
   * The remaining same-day clash, and it keeps D41's own code so the page's
   * wording stays true: two readings exist for one day and a person has to say
   * which.
   */
  it("is a same-day conflict when the target already has one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const entry = await logOne(app, user, 110.0, localDate(-20));
    await logOne(app, user, 109.0, localDate(-19));

    const response = await put(app, user, entry.id, {
      id: entry.id,
      clientUuid: randomUUID(),
      localDate: localDate(-19),
      baselineWeightKg: 110.0,
      weightKg: 110.0,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>().error).toBe("day_already_written");
    expect(await readings(app, user)).toHaveLength(2);
  });
});

describe("two creates for one day", () => {
  /**
   * What the conflict page is actually about, and now the only thing that
   * produces its message: two devices, each composing a reading for the same
   * day while the other's did not exist.
   */
  it("is still a conflict, and still carries the reading it lost to", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate(-20);

    await post(app, user, { clientUuid: randomUUID(), localDate: day, weightKg: 110.0 });

    const second = await post(app, user, {
      clientUuid: randomUUID(),
      localDate: day,
      weightKg: 108.2,
      fromQueue: true,
    });

    expect(second.statusCode).toBe(409);
    const body = second.json<{ error: string; existing: { weightKg: number } }>();
    expect(body.error).toBe("day_already_written");
    expect(body.existing.weightKg).toBe(110);

    // Nothing was written, and nothing was lost: the server still holds one.
    expect(await readings(app, user)).toHaveLength(1);
  });

  /**
   * And the resolution that keeps the waiting one is a **live** write, which
   * replaces the day per D41. Either resolution leaves exactly one row, which
   * is the property the page promises.
   */
  it("leaves exactly one row whichever resolution is taken", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate(-20);

    await post(app, user, { clientUuid: randomUUID(), localDate: day, weightKg: 110.0 });

    // "Use the waiting one": the same body, sent live.
    const resolved = await post(app, user, {
      clientUuid: randomUUID(),
      localDate: day,
      weightKg: 108.2,
    });

    expect(resolved.statusCode).toBe(200);
    const rows = await readings(app, user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weightKg).toBe(108.2);
  });
});
