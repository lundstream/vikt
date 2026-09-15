import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * `GET /api/day-table` (D167): one row per day, every figure the app keeps,
 * computed by the same functions the dashboard uses.
 */

const ctx = useTestApp();

async function seed(app: FastifyInstance, user: TestUser) {
  for (let back = 20; back >= 0; back -= 1) {
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(-back), weightKg: 90 - (20 - back) * 0.05 },
    });
    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(-back), kcal: 2200 },
    });
  }

  // Today: a partial food day, a daily log, movement and a waist.
  await app.inject({
    method: "POST",
    url: "/api/daily",
    headers: auth(user),
    payload: {
      clientUuid: randomUUID(),
      localDate: localDate(),
      sleepHours: 7.5,
      energy: 4,
      mood: 3,
      steps: 8400,
      alcoholUnits: 1,
    },
  });
  await app.inject({
    method: "POST",
    url: "/api/activity",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(), activityType: "walk", durationMin: 40 },
  });
  await app.inject({
    method: "POST",
    url: "/api/measurement",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(), waistCm: 95.5 },
  });
}

async function table(app: FastifyInstance, user: TestUser, query: string) {
  const response = await app.inject({ method: "GET", url: `/api/day-table?${query}`, headers: auth(user) });
  expect(response.statusCode).toBe(200);
  return response.json<{ from: string; to: string; rows: Record<string, unknown>[] }>();
}

describe("GET /api/day-table", () => {
  it("has a row per day from the first logged day to the day asked for", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(app, user);

    const body = await table(app, user, `to=${localDate()}`);
    expect(body.from).toBe(localDate(-20));
    expect(body.rows).toHaveLength(21);
    expect(body.rows[0]!.localDate).toBe(localDate(-20));
  });

  it("carries today's daily log, movement and waist", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(app, user);

    const today = (await table(app, user, `from=${localDate()}&to=${localDate()}`)).rows[0]!;
    expect(today).toMatchObject({
      sleepHours: 7.5,
      energy: 4,
      mood: 3,
      steps: 8400,
      alcoholUnits: 1,
      activityMinutes: 40,
      waistCm: 95.5,
      intakeKcal: 2200,
    });
  });

  /**
   * "Every number from the shared calc": the table's last row states the same
   * maintenance the dashboard states today, source and all.
   */
  it("states today's maintenance exactly as the dashboard does", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(app, user);

    const today = (await table(app, user, `from=${localDate()}&to=${localDate()}`)).rows[0]!;
    const insights = (await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })).json();

    expect(today.maintenanceKcal).toBe(insights.maintenance.tdee);
    expect(today.maintenanceSource).toBe(
      insights.maintenance.source === "none" ? null : insights.maintenance.source,
    );
    if (today.maintenanceKcal !== null) {
      expect(today.intakeMinusMaintenanceKcal).toBe(2200 - (today.maintenanceKcal as number));
    }
  });

  it("keeps one account's days out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    await seed(app, mine);

    const body = await table(app, theirs, `to=${localDate()}`);
    expect(body.rows.every((row) => row.weightKg === null && row.intakeKcal === null)).toBe(true);
  });

  it("refuses a malformed day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const response = await app.inject({ method: "GET", url: "/api/day-table?to=igår", headers: auth(user) });
    expect(response.statusCode).toBe(400);
  });
});
