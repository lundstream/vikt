import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate, logWeight } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

const post = (
  app: ReturnType<typeof ctx>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
  url: string,
  payload: Record<string, unknown>,
) => app.inject({ method: "POST", url, headers: auth(user), payload });

describe("POST /api/measurement", () => {
  it("accepts a partial measurement, because a partial day is a real day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await post(app, user, "/api/measurement", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      waistCm: 94.5,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ waistCm: number; chestCm: number | null }>();
    expect(body.waistCm).toBe(94.5);
    // Absent, not zero.
    expect(body.chestCm).toBeNull();
  });

  it("is idempotent on the client uuid", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const payload = { clientUuid: randomUUID(), localDate: localDate(), waistCm: 94 };

    const first = await post(app, user, "/api/measurement", payload);
    const second = await post(app, user, "/api/measurement", payload);

    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const list = await app.inject({
      method: "GET",
      url: "/api/measurement",
      headers: auth(user),
    });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });

  it("replaces the day rather than keeping two readings for it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await post(app, user, "/api/measurement", {
      clientUuid: randomUUID(),
      localDate: day,
      waistCm: 94,
    });
    await post(app, user, "/api/measurement", {
      clientUuid: randomUUID(),
      localDate: day,
      waistCm: 93,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/measurement",
      headers: auth(user),
    });
    const entries = list.json<{ entries: { waistCm: number }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.waistCm).toBe(93);
  });

  it("refuses a slipped decimal point", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await post(app, user, "/api/measurement", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      waistCm: 940,
    });

    expect(response.statusCode).toBe(400);
  });

  it("keeps one user's measurements out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await post(app, mine, "/api/measurement", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      waistCm: 94,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/measurement",
      headers: auth(theirs),
    });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(0);
  });
});

describe("POST /api/daily", () => {
  it("accepts one field on its own", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await post(app, user, "/api/daily", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      energy: 4,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ energy: number; sweat: number | null }>();
    expect(body.energy).toBe(4);
    expect(body.sweat).toBeNull();
  });

  it("stores the whole day when it is all sent at once", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await post(app, user, "/api/daily", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      sweat: 3,
      energy: 4,
      mood: 4,
      hunger: 2,
      sleepHours: 7.5,
      steps: 9400,
      alcoholUnits: 0,
      note: "Bra dag.",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sweat: 3,
      energy: 4,
      mood: 4,
      hunger: 2,
      sleepHours: 7.5,
      steps: 9400,
      alcoholUnits: 0,
      note: "Bra dag.",
    });
  });

  it("keeps zero alcohol units distinct from not saying", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const zero = await post(app, user, "/api/daily", {
      clientUuid: randomUUID(),
      localDate: localDate(-1),
      alcoholUnits: 0,
    });
    const absent = await post(app, user, "/api/daily", {
      clientUuid: randomUUID(),
      localDate: localDate(-2),
      energy: 3,
    });

    expect(zero.json<{ alcoholUnits: number | null }>().alcoholUnits).toBe(0);
    expect(absent.json<{ alcoholUnits: number | null }>().alcoholUnits).toBeNull();
  });

  it("refuses a rating outside 1-5", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await post(app, user, "/api/daily", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      energy: 7,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /api/activity", () => {
  it("computes the kcal estimate on the server from the MET table", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 80);

    const response = await post(app, user, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      activityType: "cycle",
      durationMin: 60,
      intensity: 3,
    });

    // 7 MET * 3.5 * 80 / 200 * 60
    expect(response.json<{ kcalEstimate: number }>().kcalEstimate).toBe(588);
    expect(response.json<{ metValue: number }>().metValue).toBe(7);
  });

  /** D33: a number the client can set is a number that can be set to anything. */
  it("ignores a kcal figure sent by the client", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 80);

    const response = await post(app, user, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      activityType: "cycle",
      durationMin: 60,
      intensity: 3,
      kcalEstimate: 99999,
    });

    expect(response.json<{ kcalEstimate: number }>().kcalEstimate).toBe(588);
  });

  it("leaves the estimate absent when there is no weight to scale it with", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await post(app, user, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      activityType: "run",
      durationMin: 30,
      intensity: 3,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ kcalEstimate: number | null }>().kcalEstimate).toBeNull();
  });

  it("keeps several sessions on one day, unlike weight and the daily log", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await post(app, user, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: day,
      activityType: "walk",
      durationMin: 30,
    });
    await post(app, user, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: day,
      activityType: "strength",
      durationMin: 45,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/activity",
      headers: auth(user),
    });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(2);
  });

  it("cannot delete someone else's session", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    const created = await post(app, mine, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: localDate(),
      activityType: "run",
      durationMin: 30,
    });
    const id = created.json<{ id: string }>().id;

    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/activity/${id}`,
      headers: auth(theirs),
    });
    expect(attempt.statusCode).toBe(404);

    const mineStill = await app.inject({
      method: "GET",
      url: "/api/activity",
      headers: auth(mine),
    });
    expect(mineStill.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });
});

describe("GET /api/day", () => {
  it("returns everything already logged, so the form opens filled in", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();
    await logWeight(app, user, 81.2);

    await post(app, user, "/api/daily", {
      clientUuid: randomUUID(),
      localDate: day,
      energy: 4,
      sleepHours: 7,
    });
    await post(app, user, "/api/measurement", {
      clientUuid: randomUUID(),
      localDate: day,
      waistCm: 94,
    });
    await post(app, user, "/api/activity", {
      clientUuid: randomUUID(),
      localDate: day,
      activityType: "walk",
      durationMin: 40,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/day?localDate=${day}`,
      headers: auth(user),
    });

    const body = response.json<{
      daily: { energy: number } | null;
      measurement: { waistCm: number } | null;
      activities: unknown[];
      weightKg: number | null;
    }>();

    expect(body.daily?.energy).toBe(4);
    expect(body.measurement?.waistCm).toBe(94);
    expect(body.activities).toHaveLength(1);
    expect(body.weightKg).toBe(81.2);
  });

  it("is empty rather than an error on a day with nothing logged", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: `/api/day?localDate=${localDate(-40)}`,
      headers: auth(user),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      daily: null,
      measurement: null,
      activities: [],
      weightKg: null,
    });
  });
});

/**
 * Bodies are sent even on the POSTs, because Fastify validates the body before
 * the `preHandler` runs: an empty POST answers 400 on the schema and would pass
 * this test without ever reaching `requireAuth`.
 */
describe("every phase 4 endpoint requires a session", () => {
  const day = localDate();

  it.each([
    ["POST", "/api/measurement", { clientUuid: randomUUID(), localDate: day, waistCm: 94 }],
    ["GET", "/api/measurement", undefined],
    ["POST", "/api/daily", { clientUuid: randomUUID(), localDate: day, energy: 3 }],
    ["GET", "/api/daily", undefined],
    [
      "POST",
      "/api/activity",
      { clientUuid: randomUUID(), localDate: day, activityType: "run", durationMin: 30 },
    ],
    ["GET", "/api/activity", undefined],
    ["GET", "/api/day?localDate=" + day, undefined],
    ["GET", "/api/correlations", undefined],
  ])("%s %s", async (method, url, payload) => {
    const { app } = ctx();
    const response = await app.inject({
      method: method as "GET",
      url: url as string,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode).toBe(401);
  });
});
