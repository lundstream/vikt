import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addDays } from "shared";
import { profiles } from "../src/db/schema.js";
import { auth, createUser, localDate, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const ctx = useTestApp();

/** Logs `days` of weight and (optionally) intake, ending today. */
async function logSeries(
  app: FastifyInstance,
  user: TestUser,
  options: {
    days: number;
    fromKg?: number;
    kgPerDay?: number;
    intakeKcal?: number | null;
    intakeDays?: number;
  },
) {
  const { days, fromKg = 100, kgPerDay = 0.05, intakeKcal = 2000 } = options;
  const intakeDays = options.intakeDays ?? days;

  for (let i = 0; i < days; i++) {
    const date = localDate(-(days - 1 - i));
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: date,
        weightKg: Number((fromKg - i * kgPerDay).toFixed(2)),
      },
    });
    if (intakeKcal !== null && i >= days - intakeDays) {
      await app.inject({
        method: "POST",
        url: "/api/manual-intake",
        headers: auth(user),
        payload: { clientUuid: randomUUID(), localDate: date, kcal: intakeKcal },
      });
    }
  }
}

async function setProfile(db: Db, userId: string, values: Record<string, unknown>) {
  await db.update(profiles).set(values).where(eq(profiles.userId, userId));
}

describe("GET /api/insights", () => {
  it("requires a session", async () => {
    const { app } = ctx();
    expect((await app.inject({ method: "GET", url: "/api/insights" })).statusCode).toBe(401);
  });

  it("returns source none for a brand new account, with nothing fabricated", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: `/api/insights?asOf=${localDate()}`,
      headers: auth(user),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.maintenance.source).toBe("none");
    expect(body.maintenance.tdee).toBeNull();
    expect(body.maintenance.confidence).toBe(0);
    expect(body.trendWeightKg).toBeNull();
    expect(body.projections.onPlan).toBeNull();
    expect(body.projections.atCurrentPace).toBeNull();
    expect(body.readingCount).toBe(0);
  });

  it("returns an adaptive figure after 28 well-logged days", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 28 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.maintenance.source).toBe("adaptive");
    expect(body.maintenance.windowDays).toBe(28);
    expect(body.maintenance.coverage).toBe(1);
    expect(body.maintenance.confidence).toBe(1);
    // Losing weight on 2000 kcal means maintenance is above it.
    expect(body.maintenance.tdee).toBeGreaterThan(2000);
  });

  it("falls back to formula below the coverage gate, when the profile allows", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await setProfile(db, user.userId, { sex: "male", birthDate: "1986-05-04" });
    await logSeries(app, user, { days: 28, intakeDays: 14 }); // 50% coverage

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.maintenance.source).toBe("formula");
    expect(body.maintenance.confidence).toBe(0.25);
    expect(body.maintenance.blockedBy).toBe("coverage");
    expect(body.maintenance.daysUntilAdaptive).toBeNull();
  });

  it("says how many days are left when history is what is missing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 10 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.maintenance.blockedBy).toBe("history");
    expect(body.maintenance.daysUntilAdaptive).toBe(4);
  });

  it("names the missing profile fields so the UI can ask for them", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 20, intakeDays: 5 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.maintenance.source).toBe("none");
    expect(body.maintenance.missing).toEqual(["sex", "birthDate"]);
  });

  it("uses the asOf the client sent, not the server's idea of today", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 20 });

    const past = addDays(localDate(), -10);
    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${past}`,
        headers: auth(user),
      })
    ).json();

    expect(body.asOf).toBe(past);
    // Ten days earlier there were only ten days of history.
    expect(body.maintenance.windowDays).toBe(10);
  });

  it("gives both projections side by side once there is a plan", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 28 });

    await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Down a bit",
        startDate: localDate(-27),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
        goalWeightKg: 95,
      },
    });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.goalWeightKg).toBe(95);
    expect(body.targetIntakeKcal).toBe(2000);
    expect(body.projections.onPlan).not.toBeNull();
    expect(body.projections.atCurrentPace).not.toBeNull();
    // They are different numbers and must not have been blended.
    expect(body.projections.onPlan.daysToGoal).toBeGreaterThan(0);
    expect(body.projections.atCurrentPace.daysToGoal).toBeGreaterThan(0);
  });

  it("returns a null pace projection for a flat series", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 28, kgPerDay: 0 });

    await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Flat",
        startDate: localDate(-27),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
        goalWeightKg: 95,
      },
    });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.projections.atCurrentPace).toBeNull();
  });

  it("keeps one user's insights out of another's", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);
    await logSeries(app, bob, { days: 28 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(alice),
      })
    ).json();

    expect(body.readingCount).toBe(0);
    expect(body.trendWeightKg).toBeNull();
    expect(body.maintenance.source).toBe("none");
  });
});

/**
 * The plan is re-checked when maintenance moves — DECISIONS.md D25. It is never
 * rewritten; the review is surfaced and the user decides.
 */
describe("plan review", () => {
  it("is absent when there is no plan", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 28 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.planReview).toBeNull();
  });

  it("fires when a plan written with no maintenance figure gets one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    // A weight exists, but no intake — so maintenance is still "none" and the
    // plan is written without one (D28 needs the weight, not the figure).
    await logWeight(app, user, 100);

    await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Written blind",
        startDate: localDate(),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
        goalWeightKg: 90,
      },
    });

    // Then a month of logging arrives and maintenance becomes adaptive.
    await logSeries(app, user, { days: 28 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.maintenance.source).toBe("adaptive");
    expect(body.planReview).not.toBeNull();
    expect(body.planReview.reason).toBe("source_improved");
    expect(body.planReview.currentTdee).toBeGreaterThan(2000);
  });

  it("reports the rate the plan now implies", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);
    await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Written blind",
        startDate: localDate(),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
        goalWeightKg: 90,
      },
    });
    await logSeries(app, user, { days: 28 });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    // Written with no maintenance figure, so no rate could be derived then.
    expect(body.planReview.plannedRateKgWeek).toBeNull();
    expect(body.planReview.impliedRateKgWeek).toBeGreaterThan(0);
  });

  it("goes quiet once the plan has been re-saved against the current figure", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 28 });

    // Written *after* the data, so it is baselined on the adaptive figure.
    await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Written with the figure in hand",
        startDate: localDate(),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
        goalWeightKg: 90,
      },
    });

    const body = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json();

    expect(body.maintenance.source).toBe("adaptive");
    expect(body.planReview).toBeNull();
  });

  it("never modifies the plan", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);
    await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Untouched",
        startDate: localDate(),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
        goalWeightKg: 90,
      },
    });
    await logSeries(app, user, { days: 28 });

    await app.inject({
      method: "GET",
      url: `/api/insights?asOf=${localDate()}`,
      headers: auth(user),
    });

    const plans = await app.inject({ method: "GET", url: "/api/plans", headers: auth(user) });
    const plan = plans.json<{ plans: { targetIntakeKcal: number; name: string }[] }>().plans[0]!;
    expect(plan.targetIntakeKcal).toBe(2000);
    expect(plan.name).toBe("Untouched");
  });

  it("records the maintenance a plan was written against", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logSeries(app, user, { days: 28 });

    const created = await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Baselined",
        startDate: localDate(),
        targetIntakeKcal: 2000,
        intakeFloorKcal: 1500,
      },
    });

    const plan = created.json<{ tdeeAtWrite: number | null; tdeeSourceAtWrite: string | null }>();
    expect(plan.tdeeAtWrite).toBeGreaterThan(2000);
    expect(plan.tdeeSourceAtWrite).toBe("adaptive");
  });
});
