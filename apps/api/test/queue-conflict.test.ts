import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * D40 and D41, at the endpoint the offline queue actually replays against.
 *
 * These are the two failure modes that only appear once writes can arrive late:
 * the same write arriving twice, and two devices writing the same day.
 */

describe("replaying a queued write (D40)", () => {
  /**
   * The failure mode nobody thinks to test: the server **committed** and the
   * response was lost. The client never heard success, so it retries. That must
   * produce one row, not two, and must not error.
   */
  it("is a no-op when the first attempt succeeded but the response was lost", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const payload = {
      clientUuid: randomUUID(),
      localDate: localDate(),
      weightKg: 84.2,
      fromQueue: true,
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload,
    });
    // The client saw nothing, so it sends the identical bytes again.
    const replay = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const list = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });

  it("does not treat its own replay as a conflict with itself", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const payload = {
      clientUuid: randomUUID(),
      localDate: localDate(),
      weightKg: 84.2,
      fromQueue: true,
    };

    await app.inject({ method: "POST", url: "/api/weight", headers: auth(user), payload });
    const replay = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload,
    });

    expect(replay.statusCode).not.toBe(409);
  });

  it("applies an amended body under the same key rather than adding a row", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const clientUuid = randomUUID();
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid, localDate: day, weightKg: 84.2, fromQueue: true },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid, localDate: day, weightKg: 83.9, fromQueue: true },
    });

    const entries = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { weightKg: number }[] }>().entries;

    expect(entries).toHaveLength(1);
    expect(entries[0]!.weightKg).toBe(83.9);
  });
});

describe("two devices writing the same day (D41)", () => {
  /**
   * The rule: a live write replaces the day, because the user is looking at the
   * current value and chose to change it.
   */
  it("lets a live write replace the day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 84.2 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 83.5 },
    });

    expect(second.statusCode).toBe(200);
    const entries = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { weightKg: number }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.weightKg).toBe(83.5);
  });

  /**
   * And a queued write does not, because it was composed before the other
   * device's reading existed and so cannot have been a decision to replace it.
   */
  it("refuses a queued write onto a day another device already wrote", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    // The desktop, online.
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 84.2 },
    });

    // The phone, coming back from offline with an older entry for the same day.
    const queued = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: day,
        weightKg: 83.1,
        fromQueue: true,
      },
    });

    expect(queued.statusCode).toBe(409);
    expect(queued.json<{ error: string }>().error).toBe("day_already_written");
  });

  /** Nothing is destroyed by the refusal: the day keeps the reading it had. */
  it("leaves the existing reading untouched", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 84.2 },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 83.1, fromQueue: true },
    });

    const entries = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { weightKg: number }[] }>().entries;

    expect(entries).toHaveLength(1);
    expect(entries[0]!.weightKg).toBe(84.2);
  });

  /**
   * The refusal has to carry what it lost to. The client shows both for the
   * user to choose between, and a second round trip assumes a network that may
   * be gone again by then.
   */
  it("returns the reading it lost to, so both can be shown", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 84.2 },
    });
    const queued = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 83.1, fromQueue: true },
    });

    const body = queued.json<{ existing?: { weightKg: number; loggedAt: string } }>();
    expect(body.existing?.weightKg).toBe(84.2);
    expect(body.existing?.loggedAt).toBeDefined();
  });

  /** The outcome must not depend on which request happened to arrive first. */
  it("is deterministic rather than last-write-wins", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    // Queued write first this time, live write second.
    const queuedFirst = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 83.1, fromQueue: true },
    });
    expect(queuedFirst.statusCode).toBe(200);

    const live = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 84.2 },
    });
    expect(live.statusCode).toBe(200);

    // The live write wins in both orderings, because the rule is about which
    // kind of write it is, not about when it turned up.
    const entries = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { weightKg: number }[] }>().entries;
    expect(entries[0]!.weightKg).toBe(84.2);
  });

  it("keeps one user's day out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(mine),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 84.2 },
    });

    // The same day for a different user is not a conflict.
    const other = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(theirs),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 70, fromQueue: true },
    });

    expect(other.statusCode).toBe(200);
  });
});

/**
 * D39 at the endpoint: the day travels with the row and the server writes it
 * through untouched. A late sync must not move an entry to the day it arrived.
 */
describe("the day a queued entry belongs to (D39)", () => {
  it("keeps the date the client sent, not the date it arrived", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const yesterday = localDate(-1);

    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: yesterday,
        weightKg: 84.2,
        fromQueue: true,
      },
    });

    expect(response.json<{ localDate: string }>().localDate).toBe(yesterday);
  });

  it("accepts an entry whose loggedAt is in a different day from its localDate", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // 23:50 in Stockholm on the 1st is 22:50 UTC, still the 1st. But an entry
    // made at 00:30 Stockholm on the 2nd is 23:30 UTC on the *1st*, and the
    // server must file it under the 2nd because that is what the client said.
    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: "2026-03-02",
        loggedAt: "2026-03-01T23:30:00.000Z",
        weightKg: 84.2,
        fromQueue: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ localDate: string }>().localDate).toBe("2026-03-02");
  });
});
