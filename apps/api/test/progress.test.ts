import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

type Milestone = {
  id: string;
  label: string;
  achievedAt: string | null;
  rewardClaimedAt: string | null;
  status: { state: string; remaining?: number };
  projectedDate: string | null;
  rewardAffordable: boolean | null;
  daysUntilAffordable: number | null;
};

type Progress = {
  streak: { days: number };
  sober: { days: number | null; basis: string; rule: string };
  pot: { balanceSek: number; accruedSek: number; paidOutSek: number; weeklyRateSek: number };
  milestones: Milestone[];
  celebrate: Milestone | null;
};

const progressFor = async (app: FastifyInstance, user: TestUser, asOf?: string) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/progress${asOf ? `?asOf=${asOf}` : ""}`,
      headers: auth(user),
    })
  ).json<Progress>();

async function addMilestone(
  app: FastifyInstance,
  user: TestUser,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/milestones",
    headers: auth(user),
    payload: body,
  });
  if (response.statusCode !== 201) {
    throw new Error(`milestone failed (${response.statusCode}): ${response.body}`);
  }
  return response.json<{ id: string }>().id;
}

describe("milestone detection", () => {
  /**
   * The rule that matters: detection runs against the trend, so a single
   * dehydrated morning below the target does not fire it.
   */
  it("does not fire on one low reading", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logWeight(app, user, 102, -2);
    await logWeight(app, user, 101.8, -1);
    await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
    });

    // A reading well under the target; the trend is nowhere near it.
    await logWeight(app, user, 99.4, 0);

    const progress = await progressFor(app, user);
    expect(progress.milestones[0]!.achievedAt).toBeNull();
  });

  /** But the scale having been there is said out loud, rather than nothing. */
  it("reports raw_reached while the trend catches up", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logWeight(app, user, 102, -2);
    await logWeight(app, user, 101.8, -1);
    await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
    });
    await logWeight(app, user, 99.4, 0);

    const progress = await progressFor(app, user);
    expect(progress.milestones[0]!.status.state).toBe("raw_reached");
  });

  it("fires once the trend actually crosses", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
    });

    // A long steady fall, so the smoothed line gets there too.
    for (let day = 40; day >= 0; day--) {
      await logWeight(app, user, 104 - (40 - day) * 0.2, -day);
    }

    const progress = await progressFor(app, user);
    expect(progress.milestones[0]!.achievedAt).not.toBeNull();
    expect(progress.milestones[0]!.status.state).toBe("achieved");
  });

  /** Achievement is permanent. A trend that rises again does not un-reach it. */
  it("never revokes an achievement when the trend rises", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
    });
    for (let day = 40; day >= 10; day--) {
      await logWeight(app, user, 104 - (40 - day) * 0.2, -day);
    }

    const before = await progressFor(app, user);
    expect(before.milestones[0]!.achievedAt).not.toBeNull();

    // Put it all back on.
    for (let day = 9; day >= 0; day--) await logWeight(app, user, 104, -day);

    const after = await progressFor(app, user);
    expect(after.milestones[0]!.achievedAt).toBe(before.milestones[0]!.achievedAt);
    expect(after.milestones[0]!.status.state).toBe("achieved");
  });

  it("keeps one user's milestones out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await addMilestone(app, mine, {
      label: "Mitt",
      metric: "weight_kg",
      targetValue: 100,
    });

    expect((await progressFor(app, theirs)).milestones).toHaveLength(0);
  });
});

/**
 * D38. The celebration is tracked by its own timestamp, so it fires once and
 * not on every dashboard load.
 */
describe("the celebration", () => {
  async function achieve(app: FastifyInstance, user: TestUser): Promise<string> {
    const id = await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
    });
    for (let day = 40; day >= 0; day--) {
      await logWeight(app, user, 104 - (40 - day) * 0.2, -day);
    }
    return id;
  }

  it("is offered once a milestone is reached", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await achieve(app, user);

    expect((await progressFor(app, user)).celebrate).not.toBeNull();
  });

  it("stays offered until it is acknowledged, not until the page reloads", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await achieve(app, user);

    expect((await progressFor(app, user)).celebrate).not.toBeNull();
    expect((await progressFor(app, user)).celebrate).not.toBeNull();
  });

  it("stops after it is acknowledged", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await achieve(app, user);

    const ack = await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/celebrated`,
      headers: auth(user),
    });
    expect(ack.statusCode).toBe(204);

    expect((await progressFor(app, user)).celebrate).toBeNull();
  });

  it("treats a repeated acknowledgement as a no-op, not an error", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await achieve(app, user);

    for (let i = 0; i < 3; i++) {
      const ack = await app.inject({
        method: "POST",
        url: `/api/milestones/${id}/celebrated`,
        headers: auth(user),
      });
      expect(ack.statusCode).toBe(204);
    }
    expect((await progressFor(app, user)).celebrate).toBeNull();
  });

  /**
   * The state that makes one-shot possible at all: "achieved" and "already
   * shown" are different facts, so the flag cannot be inferred from
   * `achieved_at` (§3, D17).
   */
  it("does not re-offer after more writes on the same milestone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await achieve(app, user);

    await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/celebrated`,
      headers: auth(user),
    });
    await logWeight(app, user, 95, 0);

    expect((await progressFor(app, user)).celebrate).toBeNull();
  });
});

describe("the savings pot", () => {
  async function addRule(
    app: FastifyInstance,
    user: TestUser,
    body: Record<string, unknown>,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/savings/rules",
      headers: auth(user),
      payload: body,
    });
    if (response.statusCode !== 201) {
      throw new Error(`rule failed (${response.statusCode}): ${response.body}`);
    }
    return response.json<{ id: string }>().id;
  }

  it("accrues from the rules without any cron having run", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const progress = await progressFor(app, user);
    expect(progress.pot.accruedSek).toBe(1000);
    expect(progress.pot.balanceSek).toBe(1000);
  });

  it("subtracts a day the thing was bought after all", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const ruleId = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const offset = await app.inject({
      method: "POST",
      url: "/api/savings/offsets",
      headers: auth(user),
      payload: { ruleId, localDate: localDate(-3) },
    });
    expect(offset.statusCode).toBe(204);

    expect((await progressFor(app, user)).pot.balanceSek).toBe(900);
  });

  it("files the same offset twice as one fact, not two deductions", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const ruleId = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "POST",
        url: "/api/savings/offsets",
        headers: auth(user),
        payload: { ruleId, localDate: localDate(-3) },
      });
    }

    expect((await progressFor(app, user)).pot.balanceSek).toBe(900);
  });

  /** A rule id is a uuid in a request body; it must not reach another pot. */
  it("refuses an offset against someone else's rule", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    const ruleId = await addRule(app, mine, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const attempt = await app.inject({
      method: "POST",
      url: "/api/savings/offsets",
      headers: auth(theirs),
      payload: { ruleId, localDate: localDate(-3) },
    });

    expect(attempt.statusCode).toBe(404);
    expect((await progressFor(app, mine)).pot.balanceSek).toBe(1000);
  });

  it("adds a one-off event", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/savings/events",
      headers: auth(user),
      payload: { localDate: localDate(-1), label: "Sålde cykeln", amountSek: 500 },
    });

    expect((await progressFor(app, user)).pot.balanceSek).toBe(500);
  });

  it("returns a daily series so the pot can be drawn climbing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-4),
    });

    const pot = (
      await app.inject({ method: "GET", url: "/api/pot", headers: auth(user) })
    ).json<{ series: { balanceSek: number }[] }>();

    expect(pot.series.map((point) => point.balanceSek)).toEqual([100, 200, 300, 400, 500]);
  });

  it("keeps one user's pot out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await addRule(app, mine, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    expect((await progressFor(app, theirs)).pot.balanceSek).toBe(0);
  });
});

describe("claiming a reward", () => {
  async function achievedWithReward(
    app: FastifyInstance,
    user: TestUser,
    costSek: number,
  ): Promise<string> {
    const id = await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
      rewardText: "Nya skor",
      rewardCostSek: costSek,
    });
    for (let day = 40; day >= 0; day--) {
      await logWeight(app, user, 104 - (40 - day) * 0.2, -day);
    }
    return id;
  }

  it("draws the pot down by the cost", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/savings/events",
      headers: auth(user),
      payload: { localDate: localDate(-1), label: "Start", amountSek: 2000 },
    });
    const id = await achievedWithReward(app, user, 1200);

    const claim = await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });
    expect(claim.statusCode).toBe(200);

    const progress = await progressFor(app, user);
    expect(progress.pot.paidOutSek).toBe(1200);
    expect(progress.pot.balanceSek).toBe(800);
  });

  /**
   * Claiming early is a real choice. Clamping the balance at zero would hide a
   * debt the user took on deliberately.
   */
  it("lets the pot go negative rather than refusing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await achievedWithReward(app, user, 1500);

    const claim = await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });

    expect(claim.statusCode).toBe(200);
    expect((await progressFor(app, user)).pot.balanceSek).toBe(-1500);
  });

  it("cannot be claimed twice", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await achievedWithReward(app, user, 500);

    await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });

    expect(again.statusCode).toBe(409);
    expect((await progressFor(app, user)).pot.paidOutSek).toBe(500);
  });

  it("cannot be claimed before it is reached", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addMilestone(app, user, {
      label: "Under 100",
      metric: "weight_kg",
      targetValue: 100,
      rewardCostSek: 500,
    });

    const claim = await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });

    expect(claim.statusCode).toBe(422);
  });

  /**
   * D17 names `savings_events.milestone_id` as provenance only. Whether a
   * reward has been paid is `reward_claimed_at`, and deleting the event must
   * not make it claimable again.
   */
  it("stays claimed after its payout event is deleted", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await achievedWithReward(app, user, 500);

    await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });

    const events = (await progressFor(app, user)).pot as unknown as {
      balanceSek: number;
    };
    expect(events.balanceSek).toBe(-500);

    const eventId = (
      await app.inject({ method: "GET", url: "/api/pot", headers: auth(user) })
    ).json<{ events: { id: string }[] }>().events[0]!.id;

    await app.inject({
      method: "DELETE",
      url: `/api/savings/events/${eventId}`,
      headers: auth(user),
    });

    const again = await app.inject({
      method: "POST",
      url: `/api/milestones/${id}/claim`,
      headers: auth(user),
      payload: { asOf: localDate() },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("the streak and the sober counter", () => {
  it("counts a day logged in any of the three places", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logWeight(app, user, 90, -1);
    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), energy: 3 },
    });

    expect((await progressFor(app, user)).streak.days).toBe(2);
  });

  /** D35, end to end: an unlogged day is unknown, not dry. */
  it("stops the sober count at a gap rather than rewarding silence", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const post = (offset: number, alcoholUnits: number) =>
      app.inject({
        method: "POST",
        url: "/api/daily",
        headers: auth(user),
        payload: { clientUuid: randomUUID(), localDate: localDate(offset), alcoholUnits },
      });

    await post(-5, 4);
    await post(-4, 0);
    // -3 and -2 not logged at all.
    await post(-1, 0);

    const sober = (await progressFor(app, user)).sober;
    expect(sober.basis).toBe("gap");
    expect(sober.rule).toBe("strict");
  });

  it("says it cannot tell before anything is logged", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const sober = (await progressFor(app, user)).sober;
    expect(sober.days).toBeNull();
    expect(sober.basis).toBe("no_data");
  });

  it("counts through gaps once the user opts into that reading", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { soberAssumeUnloggedDry: true },
    });

    const post = (offset: number, alcoholUnits: number) =>
      app.inject({
        method: "POST",
        url: "/api/daily",
        headers: auth(user),
        payload: { clientUuid: randomUUID(), localDate: localDate(offset), alcoholUnits },
      });

    await post(-5, 4);
    await post(-1, 0);

    const sober = (await progressFor(app, user)).sober;
    expect(sober.rule).toBe("assumeSober");
    expect(sober.days).toBe(5);
  });
});

describe("every progress endpoint requires a session", () => {
  it.each([
    ["GET", "/api/progress", undefined],
    ["GET", "/api/pot", undefined],
    [
      "POST",
      "/api/milestones",
      { label: "x", metric: "weight_kg", targetValue: 100 },
    ],
    [
      "POST",
      "/api/savings/rules",
      { label: "x", amountSek: 10, cadence: "every_day", startDate: "2026-03-01" },
    ],
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

/**
 * D49. Two identical milestones are one goal entered twice, and the app handles
 * them badly: detection stamps both, and the celebration then fires once per
 * row because `celebrated_at` is per row and both are legitimately
 * uncelebrated. Reaching 100 kg would be announced twice.
 */
describe("duplicate milestones", () => {
  const target = {
    label: "Under 100",
    metric: "weight_kg" as const,
    targetValue: 100,
  };

  it("refuses a second milestone on the same metric and target", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const first = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: target,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: { ...target, label: "Under hundra" },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe("milestone_exists");
  });

  it("names the one that is already there, so the refusal is actionable", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: target,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: target,
    });

    expect(second.json<{ message: string }>().message).toContain("Under 100");
  });

  /** The normal case: a ladder of targets on one metric. */
  it("allows different targets on the same metric", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const value of [100, 95, 90]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/milestones",
        headers: auth(user),
        payload: { ...target, label: `Under ${value}`, targetValue: value },
      });
      expect(response.statusCode).toBe(201);
    }
  });

  it("allows the same target on a different metric", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: target,
    });
    const waist = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: { label: "Midja 100", metric: "waist_cm", targetValue: 100 },
    });

    expect(waist.statusCode).toBe(201);
  });

  /** One user's milestone must not block another's. */
  it("is scoped per user", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(mine),
      payload: target,
    });
    const other = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(theirs),
      payload: target,
    });

    expect(other.statusCode).toBe(201);
  });

  /**
   * The consequence the rule exists to prevent, asserted directly: one
   * achievement produces exactly one thing to celebrate.
   */
  it("leaves exactly one celebration for one achievement", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: target,
    });
    // The duplicate is refused, so it cannot contribute a second celebration.
    await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: target,
    });

    for (let day = 40; day >= 0; day--) {
      await logWeight(app, user, 104 - (40 - day) * 0.2, -day);
    }

    const progress = await progressFor(app, user);
    expect(progress.milestones.filter((m) => m.achievedAt !== null)).toHaveLength(1);
    expect(progress.celebrate).not.toBeNull();

    await app.inject({
      method: "POST",
      url: `/api/milestones/${progress.celebrate!.id}/celebrated`,
      headers: auth(user),
    });
    expect((await progressFor(app, user)).celebrate).toBeNull();
  });
});
