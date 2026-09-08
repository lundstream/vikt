import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Product guardrails — CLAUDE.md §3. Enforced server-side, not just in the UI,
 * and rejected with a readable 422 rather than a generic validation error.
 */

/** 28 days of weight and intake, which is what produces an adaptive figure. */
async function withMaintenance(
  app: FastifyInstance,
  user: TestUser,
  startKg: number,
): Promise<void> {
  for (let i = 27; i >= 0; i--) {
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-i),
        weightKg: Number((startKg - (27 - i) * 0.05).toFixed(2)),
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(-i), kcal: 2000 },
    });
  }
}

function planPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Plan",
    startDate: localDate(),
    targetIntakeKcal: 2000,
    intakeFloorKcal: 1500,
    ...overrides,
  };
}

const createPlan = (app: FastifyInstance, user: TestUser, overrides = {}) =>
  app.inject({
    method: "POST",
    url: `/api/plans?asOf=${localDate()}`,
    headers: auth(user),
    payload: planPayload(overrides),
  });

describe("the plan endpoint rejects an intake below the floor", () => {
  it("answers 422, not 400 or 500", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const response = await createPlan(app, user, { targetIntakeKcal: 900 });
    expect(response.statusCode).toBe(422);
  });

  it("says something a person can act on, naming both numbers", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const response = await createPlan(app, user, { targetIntakeKcal: 900 });
    const body = response.json<{ error: string; message: string }>();

    // 900 is under the 1200 system floor, so that is the limit it reports.
    expect(body.error).toBe("intake_below_system_floor");
    expect(body.message).toContain("900");
    expect(body.message).toContain("1200");
    expect(body.message).not.toMatch(/instancePath|should NOT|invalid_type/);
    expect(body.message.length).toBeGreaterThan(30);
  });

  it("writes nothing when it refuses", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    await createPlan(app, user, { targetIntakeKcal: 900 });

    const plans = await app.inject({ method: "GET", url: "/api/plans", headers: auth(user) });
    expect(plans.json<{ plans: unknown[] }>().plans).toEqual([]);
  });

  it("accepts a target exactly on the floor", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const response = await createPlan(app, user, {
      targetIntakeKcal: 1500,
      intakeFloorKcal: 1500,
    });
    expect(response.statusCode).toBe(201);
  });

  it("applies the floor on edit as well as on create", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const created = await createPlan(app, user, { targetIntakeKcal: 2200 });
    const planId = created.json<{ id: string }>().id;

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/plans/${planId}?asOf=${localDate()}`,
      headers: auth(user),
      payload: { targetIntakeKcal: 800 },
    });

    expect(edit.statusCode).toBe(422);
    expect(edit.json<{ message: string }>().message).toContain("800");
    expect(edit.json<{ error: string }>().error).toBe("intake_below_system_floor");
  });
});

/**
 * The rate is derived from the target against maintenance (D27), so these drive
 * it with the target rather than by typing a rate beside it.
 */
describe("the plan endpoint rejects losing faster than 1% of bodyweight a week", () => {
  it("refuses a target whose implied rate is too fast", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withMaintenance(app, user, 60);

    // At 60 kg the cap is 0.60 kg/week; a 1200 target implies far more.
    const response = await createPlan(app, user, {
      targetIntakeKcal: 1200,
      intakeFloorKcal: 1200,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("rate_too_fast");
    expect(response.json<{ message: string }>().message).toMatch(/1 %|0,60|0\.60/);
  });

  it("accepts a target whose implied rate is within the cap", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withMaintenance(app, user, 100);

    const response = await createPlan(app, user, { targetIntakeKcal: 2200 });
    expect(response.statusCode).toBe(201);
  });

  it("measures the cap against this user's weight, not a constant", async () => {
    const { app, db } = ctx();
    const light = await createUser(app, db);
    const heavy = await createUser(app, db);
    await withMaintenance(app, light, 55);
    await withMaintenance(app, heavy, 110);

    const overrides = { targetIntakeKcal: 1400, intakeFloorKcal: 1200 };
    const forLight = await createPlan(app, light, overrides);
    const forHeavy = await createPlan(app, heavy, overrides);

    expect(forLight.statusCode).toBe(422);
    expect(forHeavy.statusCode).toBe(201);
  });
});

/**
 * D28. A plan saved before there is a weight is a plan no rule has looked at,
 * and that is exactly the moment people set one.
 */
describe("a plan needs a weight reading first", () => {
  it("refuses to save one without any weight logged", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await createPlan(app, user);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("no_weight_reading");
  });

  it("says why, in terms of what cannot be checked", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const message = (await createPlan(app, user)).json<{ message: string }>().message;
    expect(message).toMatch(/Logga en vikt/);
    expect(message).toMatch(/1 %/);
  });

  it("writes nothing when it refuses", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await createPlan(app, user);

    const plans = await app.inject({ method: "GET", url: "/api/plans", headers: auth(user) });
    expect(plans.json<{ plans: unknown[] }>().plans).toEqual([]);
  });

  it("accepts one as soon as a weight exists", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 88);

    expect((await createPlan(app, user)).statusCode).toBe(201);
  });

  it("applies on edit as well as on create", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 88);

    const created = await createPlan(app, user);
    expect(created.statusCode).toBe(201);

    await db.execute(sql`delete from weight_log`);

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/plans/${created.json<{ id: string }>().id}?asOf=${localDate()}`,
      headers: auth(user),
      payload: { targetIntakeKcal: 1900 },
    });

    expect(edit.statusCode).toBe(422);
    expect(edit.json<{ error: string }>().error).toBe("no_weight_reading");
  });
});

/**
 * D27. The stored rate is derived from the target, so the two cannot diverge —
 * they already had: an 1800 target against 3000 maintenance implied 1.09 kg/week
 * while the stored rate said 1.00, and nothing read the stored one.
 */
describe("the planned rate is derived, never typed", () => {
  it("stores exactly the rate the target implies against maintenance", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withMaintenance(app, user, 100);

    const created = await createPlan(app, user, { targetIntakeKcal: 2000 });
    expect(created.statusCode).toBe(201);

    const plan = created.json<{ targetRateKgWeek: number | null; tdeeAtWrite: number }>();
    // The invariant: implied === stored, always.
    const implied = ((plan.tdeeAtWrite - 2000) * 7) / 7700;

    expect(plan.targetRateKgWeek).not.toBeNull();
    expect(plan.targetRateKgWeek!).toBeCloseTo(implied, 2);
  });

  it("holds across several targets", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withMaintenance(app, user, 100);

    for (const target of [1900, 2100, 2300]) {
      const created = await createPlan(app, user, { targetIntakeKcal: target });
      expect(created.statusCode, String(target)).toBe(201);
      const plan = created.json<{ targetRateKgWeek: number; tdeeAtWrite: number }>();
      expect(plan.targetRateKgWeek, String(target)).toBeCloseTo(
        ((plan.tdeeAtWrite - target) * 7) / 7700,
        2,
      );
    }
  });

  it("ignores a rate sent by a client that has not been updated", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withMaintenance(app, user, 100);

    const created = await createPlan(app, user, {
      targetIntakeKcal: 2000,
      // A number the client has no business setting.
      targetRateKgWeek: 99,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<{ targetRateKgWeek: number }>().targetRateKgWeek).toBeLessThan(2);
  });

  it("re-derives the rate when the target is edited", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withMaintenance(app, user, 100);

    const created = await createPlan(app, user, { targetIntakeKcal: 2000 });
    const before = created.json<{ id: string; targetRateKgWeek: number }>();

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/plans/${before.id}?asOf=${localDate()}`,
      headers: auth(user),
      payload: { targetIntakeKcal: 2300 },
    });

    // A higher target is a smaller deficit, so a slower rate.
    expect(edited.json<{ targetRateKgWeek: number }>().targetRateKgWeek).toBeLessThan(
      before.targetRateKgWeek,
    );
  });
});

/**
 * The system floor — DECISIONS.md D24. A limit the user can lower is advice,
 * not a guardrail.
 */
describe("the system intake floor", () => {
  it("refuses a target below it even when the user's own floor is lower", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const response = await createPlan(app, user, {
      targetIntakeKcal: 900,
      intakeFloorKcal: 800,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("intake_below_system_floor");
  });

  it("says the limit is not adjustable from here", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const message = (
      await createPlan(app, user, { targetIntakeKcal: 900, intakeFloorKcal: 800 })
    ).json<{ message: string }>().message;

    expect(message).toContain("1200");
    expect(message).toMatch(/går inte att ändra/i);
  });

  it("distinguishes the user's own floor from the system one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    // 1400 clears the system floor but not the user's own 1500.
    const response = await createPlan(app, user, { targetIntakeKcal: 1400 });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("intake_below_floor");
    expect(response.json<{ message: string }>().message).toContain("1200");
  });

  it("lets a user raise the limit above the system floor", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const ok = await createPlan(app, user, {
      targetIntakeKcal: 1900,
      intakeFloorKcal: 1800,
    });
    expect(ok.statusCode).toBe(201);

    const refused = await createPlan(app, user, {
      targetIntakeKcal: 1700,
      intakeFloorKcal: 1800,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: string }>().error).toBe("intake_below_floor");
  });

  it("accepts a target exactly on the system floor", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 100);

    const response = await createPlan(app, user, {
      targetIntakeKcal: 1200,
      intakeFloorKcal: 0,
    });
    expect(response.statusCode).toBe(201);
  });

  it("is reported to the client so the form can bound its own field", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const insights = await app.inject({
      method: "GET",
      url: `/api/insights?asOf=${localDate()}`,
      headers: auth(user),
    });
    expect(insights.json<{ systemFloorKcal: number }>().systemFloorKcal).toBe(1200);
  });
});
