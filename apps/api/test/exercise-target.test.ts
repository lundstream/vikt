import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import type { FastifyInstance } from "fastify";

const ctx = useTestApp();

/**
 * D31, tested in both directions as the phase-4 brief requires: the toggle must
 * be **unavailable** while maintenance is adaptive, and may apply when it comes
 * from the formula.
 *
 * The reason it cannot simply default to off: an adaptive figure is derived
 * from what the trend line actually did against what was actually eaten, so the
 * training is already inside it. Adding it again is a double count that grows
 * with training volume.
 */

/**
 * Enough history for §4.2 to return an adaptive figure: a 28-day window, a
 * reading and a food log every day, so coverage clears the 80% gate.
 */
async function buildAdaptiveHistory(app: FastifyInstance, user: TestUser): Promise<void> {
  for (let day = 34; day >= 0; day--) {
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-day),
        weightKg: 88 - day * 0.02,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(-day), kcal: 2100 },
    });
  }
}

const insightsFor = async (app: FastifyInstance, user: TestUser) =>
  (
    await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
  ).json<{
    maintenance: { source: string };
    exerciseAdjustment: {
      available: boolean;
      inForce: boolean;
      preference: boolean;
      reason: string;
    };
  }>();

describe("adding exercise to the target, with an adaptive figure", () => {
  it("is reported unavailable, with the reason", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await buildAdaptiveHistory(app, user);

    const insights = await insightsFor(app, user);

    expect(insights.maintenance.source).toBe("adaptive");
    expect(insights.exerciseAdjustment.available).toBe(false);
    expect(insights.exerciseAdjustment.inForce).toBe(false);
    expect(insights.exerciseAdjustment.reason).toBe("adaptive_includes_activity");
  });

  /**
   * The half that matters. A greyed-out switch is a UI detail; a 422 is the
   * thing that makes "unavailable" true.
   */
  it("is refused by the API, not merely hidden in the UI", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await buildAdaptiveHistory(app, user);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { addExerciseToTarget: true },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("adaptive_includes_activity");
  });

  it("says why in words the user can act on", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await buildAdaptiveHistory(app, user);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { addExerciseToTarget: true },
    });

    expect(response.json<{ message: string }>().message).toContain("två gånger");
  });

  it("leaves the stored preference alone rather than clearing it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // Set while there is no adaptive figure yet.
    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { sex: "male", birthDate: "1985-05-01" },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });
    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { addExerciseToTarget: true },
    });
    expect(enabled.statusCode).toBe(200);

    // Then earn an adaptive figure.
    await buildAdaptiveHistory(app, user);
    const insights = await insightsFor(app, user);

    expect(insights.maintenance.source).toBe("adaptive");
    // Preserved, but not in force.
    expect(insights.exerciseAdjustment.preference).toBe(true);
    expect(insights.exerciseAdjustment.inForce).toBe(false);
  });
});

describe("adding exercise to the target, with a formula figure", () => {
  it("may be switched on", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { sex: "male", birthDate: "1985-05-01" },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { addExerciseToTarget: true },
    });
    expect(response.statusCode).toBe(200);

    const insights = await insightsFor(app, user);
    expect(insights.maintenance.source).toBe("formula");
    expect(insights.exerciseAdjustment.available).toBe(true);
    expect(insights.exerciseAdjustment.inForce).toBe(true);
    expect(insights.exerciseAdjustment.reason).toBe("formula");
  });

  it("is available but not in force when it is switched off", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { sex: "male", birthDate: "1985-05-01" },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });

    const insights = await insightsFor(app, user);
    expect(insights.exerciseAdjustment.available).toBe(true);
    expect(insights.exerciseAdjustment.inForce).toBe(false);
  });
});

describe("with no maintenance figure at all", () => {
  it("is unavailable, because there is nothing to add to", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const insights = await insightsFor(app, user);
    expect(insights.maintenance.source).toBe("none");
    expect(insights.exerciseAdjustment.available).toBe(false);
    expect(insights.exerciseAdjustment.reason).toBe("no_maintenance_figure");
  });
});

/**
 * D33, enforced end to end. Activity is a record of what you did, not an input
 * to the maths — so logging a hard week must not move maintenance or either
 * projection by a single kcal.
 */
describe("activity never reaches the maths", () => {
  it("logging activity leaves maintenance and the projections identical", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await buildAdaptiveHistory(app, user);

    const before = await app.inject({
      method: "GET",
      url: "/api/insights",
      headers: auth(user),
    });

    for (let day = 6; day >= 0; day--) {
      await app.inject({
        method: "POST",
        url: "/api/activity",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(-day),
          activityType: "run",
          durationMin: 75,
          intensity: 5,
        },
      });
    }

    const after = await app.inject({
      method: "GET",
      url: "/api/insights",
      headers: auth(user),
    });

    // Byte-identical: not "close", not "within rounding".
    expect(after.json()).toEqual(before.json());
  });
});
