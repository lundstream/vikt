import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Editing and deleting a milestone, and the target band.
 *
 * §3 now says every user-created row ships with edit and delete in the phase
 * that creates it. The API had both for milestones and the UI had neither,
 * which is the same gap wearing a different coat: an endpoint nothing calls is
 * not a feature. These pin the endpoints; the browser pass covers the controls.
 *
 * The band exists because the target field had no unit, so 95 was a plausible
 * waist, a plausible weight and a nonsense ratio, and the form took all three.
 */

async function addMilestone(
  app: FastifyInstance,
  user: TestUser,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: "/api/milestones",
    headers: auth(user),
    payload: { label: "Mål", ...body },
  });
}

const progressOf = async (app: FastifyInstance, user: TestUser) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/progress?asOf=${localDate()}`,
      headers: auth(user),
    })
  ).json();

describe("milestones can be edited", () => {
  it("changes the label, target and reward", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 95);

    const id = (await addMilestone(app, user, { metric: "weight_kg", targetValue: 90 })).json()
      .id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/milestones/${id}`,
      headers: auth(user),
      payload: { label: "Under 88", targetValue: 88, rewardText: "Skor", rewardCostSek: 900 },
    });
    expect(response.statusCode).toBe(200);

    const [milestone] = (await progressOf(app, user)).milestones;
    expect(milestone.label).toBe("Under 88");
    expect(milestone.targetValue).toBe(88);
    expect(milestone.rewardText).toBe("Skor");
    expect(milestone.rewardCostSek).toBe(900);
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const id = (await addMilestone(app, owner, { metric: "weight_kg", targetValue: 90 })).json()
      .id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/milestones/${id}`,
      headers: auth(stranger),
      payload: { label: "Kapad" },
    });

    expect(response.statusCode).toBe(404);
    expect((await progressOf(app, owner)).milestones[0].label).toBe("Mål");
  });
});

describe("milestones can be deleted", () => {
  it("removes the row", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = (await addMilestone(app, user, { metric: "weight_kg", targetValue: 90 })).json()
      .id;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/milestones/${id}`,
      headers: auth(user),
    });

    expect(response.statusCode).toBe(204);
    expect((await progressOf(app, user)).milestones).toHaveLength(0);
  });

  /**
   * D49 refuses a second milestone on the same metric and target. Deleting the
   * first has to make that target available again, or the refusal becomes a
   * permanent lock on a number someone typed once.
   */
  it("frees the metric and target for a new one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = (await addMilestone(app, user, { metric: "weight_kg", targetValue: 90 })).json()
      .id;

    expect((await addMilestone(app, user, { metric: "weight_kg", targetValue: 90 })).statusCode).toBe(
      409,
    );

    await app.inject({ method: "DELETE", url: `/api/milestones/${id}`, headers: auth(user) });

    expect((await addMilestone(app, user, { metric: "weight_kg", targetValue: 90 })).statusCode).toBe(
      201,
    );
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const id = (await addMilestone(app, owner, { metric: "weight_kg", targetValue: 90 })).json()
      .id;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/milestones/${id}`,
      headers: auth(stranger),
    });

    expect(response.statusCode).toBe(404);
    expect((await progressOf(app, owner)).milestones).toHaveLength(1);
  });
});

describe("the target band", () => {
  it("refuses a ratio typed as a percentage, and names the range", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await addMilestone(app, user, { metric: "whtr", targetValue: 48 });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("target_out_of_range");
    // Naming the band is what makes the message actionable.
    expect(response.json().message).toContain("0,2");
    expect(response.json().message).toContain("1,5");
  });

  it("refuses a weight that is really a waist", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    expect((await addMilestone(app, user, { metric: "weight_kg", targetValue: 9 })).statusCode).toBe(
      422,
    );
  });

  it("accepts the ordinary cases", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const [metric, targetValue] of [
      ["weight_kg", 85],
      ["waist_cm", 95],
      ["whtr", 0.48],
      ["sober_days", 100],
      ["log_streak_days", 30],
    ] as const) {
      expect((await addMilestone(app, user, { metric, targetValue })).statusCode).toBe(201);
    }
  });

  /**
   * The edit path validates against the metric the row *ends up* with. Changing
   * only the metric leaves the stored target in place, and 95 kg becomes a
   * waist-to-height ratio of 95 if nothing checks the pair.
   */
  it("refuses a metric change that leaves the stored target impossible", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = (await addMilestone(app, user, { metric: "weight_kg", targetValue: 95 })).json()
      .id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/milestones/${id}`,
      headers: auth(user),
      payload: { metric: "whtr" },
    });

    expect(response.statusCode).toBe(422);
    // Unchanged, rather than saved as a ratio of 95.
    const [milestone] = (await progressOf(app, user)).milestones;
    expect(milestone.metric).toBe("weight_kg");
    expect(milestone.targetValue).toBe(95);
  });

  it("allows a metric change that comes with a target to match", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = (await addMilestone(app, user, { metric: "weight_kg", targetValue: 95 })).json()
      .id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/milestones/${id}`,
      headers: auth(user),
      payload: { metric: "whtr", targetValue: 0.5 },
    });

    expect(response.statusCode).toBe(200);
    const [milestone] = (await progressOf(app, user)).milestones;
    expect(milestone.metric).toBe("whtr");
    expect(milestone.targetValue).toBe(0.5);
  });

  it("leaves a label-only edit alone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = (await addMilestone(app, user, { metric: "whtr", targetValue: 0.48 })).json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/milestones/${id}`,
      headers: auth(user),
      payload: { label: "Bara namnet" },
    });

    expect(response.statusCode).toBe(200);
  });
});

/**
 * The case the diagnosis for this pass ruled out, kept so it stays ruled out:
 * two milestones on different metrics are two milestones, and both come back.
 */
describe("two milestones on different metrics", () => {
  it("both save and both are returned", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    expect(
      (await addMilestone(app, user, { label: "Tvåsiffrigt", metric: "weight_kg", targetValue: 99 }))
        .statusCode,
    ).toBe(201);
    expect(
      (
        await addMilestone(app, user, {
          label: "100 dagar nykter",
          metric: "sober_days",
          targetValue: 100,
        })
      ).statusCode,
    ).toBe(201);

    const { milestones } = await progressOf(app, user);
    expect(milestones).toHaveLength(2);
    expect(milestones.map((m: { metric: string }) => m.metric)).toEqual([
      "weight_kg",
      "sober_days",
    ]);
  });
});
