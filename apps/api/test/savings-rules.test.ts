import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Editing and deleting a savings rule, and the preview that has to come first.
 *
 * §4.5 accrues the pot **on read**: no per-day rows are written, so the rule is
 * the record and every change to it is retroactive. That is the right design
 * and a surprising one, so the consequence is a number the user confirms rather
 * than something they discover afterwards. These tests pin the preview against
 * the real balance, because a preview that disagrees with what actually happens
 * is worse than no preview.
 */

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

async function potOf(app: FastifyInstance, user: TestUser) {
  const response = await app.inject({
    method: "GET",
    url: `/api/progress?asOf=${localDate()}`,
    headers: auth(user),
  });
  return response.json().pot;
}

const preview = (
  app: FastifyInstance,
  user: TestUser,
  id: string,
  next: Record<string, unknown> | null,
) =>
  app.inject({
    method: "POST",
    url: `/api/savings/rules/${id}/preview`,
    headers: auth(user),
    payload: { asOf: localDate(), next },
  });

describe("previewing a rule change", () => {
  it("shows what deleting a rule takes out of the pot", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const body = (await preview(app, user, id, null)).json();

    expect(body.currentBalanceSek).toBe(1000);
    expect(body.nextBalanceSek).toBe(0);
    expect(body.deltaSek).toBe(-1000);
    expect(body.currentRuleAccruedSek).toBe(1000);
    // The rule is gone in the projection, so it accrues nothing.
    expect(body.nextRuleAccruedSek).toBe(0);
  });

  /**
   * The behaviour the preview exists for. Moving a start date backwards does
   * not change the rate going forward; it makes past savings appear.
   */
  it("shows that moving a start date backwards creates savings retroactively", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-4),
    });

    const body = (await preview(app, user, id, { startDate: localDate(-9) })).json();

    expect(body.currentBalanceSek).toBe(500);
    expect(body.nextBalanceSek).toBe(1000);
    expect(body.deltaSek).toBe(500);
    expect(body.currentEligibleDays).toBe(5);
    expect(body.nextEligibleDays).toBe(10);
  });

  it("shows a narrowed cadence removing days that were already counted", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-13),
    });

    const body = (await preview(app, user, id, { cadence: "weekend_day" })).json();

    expect(body.currentEligibleDays).toBe(14);
    // Two weeks contain four weekend days.
    expect(body.nextEligibleDays).toBe(4);
    expect(body.nextBalanceSek).toBeLessThan(body.currentBalanceSek);
  });

  it("leaves fields it was not given alone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    // Only the label. The amount and cadence must survive the merge, or the
    // preview would report a rule change nobody asked for.
    const body = (await preview(app, user, id, { label: "Fika" })).json();
    expect(body.deltaSek).toBe(0);
    expect(body.nextBalanceSek).toBe(1000);
  });

  it("names a reward the change would put back out of reach", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const milestone = await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: {
        label: "85 kg",
        metric: "weight_kg",
        targetValue: 85,
        rewardText: "Nya skor",
        rewardCostSek: 800,
      },
    });
    expect(milestone.statusCode).toBe(201);

    // 1000 covers the 800 kr reward; deleting the rule leaves 0.
    expect((await preview(app, user, id, null)).json().wouldUnaffordReward).toBe(true);
    // A change that keeps the pot above the cost does not.
    expect(
      (await preview(app, user, id, { amountSek: 90 })).json().wouldUnaffordReward,
    ).toBe(false);
  });

  it("writes nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    await preview(app, user, id, null);
    await preview(app, user, id, { startDate: localDate(-30) });

    expect((await potOf(app, user)).balanceSek).toBe(1000);
  });

  it("agrees with what the edit actually does", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-4),
    });

    const predicted = (await preview(app, user, id, { startDate: localDate(-9) })).json();

    await app.inject({
      method: "PATCH",
      url: `/api/savings/rules/${id}`,
      headers: auth(user),
      payload: { startDate: localDate(-9) },
    });

    expect((await potOf(app, user)).balanceSek).toBe(predicted.nextBalanceSek);
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const id = await addRule(app, owner, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    expect((await preview(app, stranger, id, null)).statusCode).toBe(404);
  });
});

describe("deleting a rule", () => {
  it("removes it and what it accrued", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/savings/rules/${id}`,
      headers: auth(user),
    });

    expect(response.statusCode).toBe(204);

    const pot = await potOf(app, user);
    expect(pot.rules).toHaveLength(0);
    expect(pot.balanceSek).toBe(0);
  });

  it("takes its offsets with it, rather than leaving deductions from nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    await app.inject({
      method: "POST",
      url: "/api/savings/offsets",
      headers: auth(user),
      payload: { ruleId: id, localDate: localDate(-2) },
    });

    expect((await potOf(app, user)).balanceSek).toBe(900);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/savings/rules/${id}`,
      headers: auth(user),
    });
    expect(response.statusCode).toBe(204);
    expect((await potOf(app, user)).balanceSek).toBe(0);
  });

  it("leaves one-off events alone, which are their own record", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await addRule(app, user, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    await app.inject({
      method: "POST",
      url: "/api/savings/events",
      headers: auth(user),
      payload: { localDate: localDate(-1), label: "Sålde cykeln", amountSek: 500 },
    });

    await app.inject({
      method: "DELETE",
      url: `/api/savings/rules/${id}`,
      headers: auth(user),
    });

    expect((await potOf(app, user)).balanceSek).toBe(500);
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const id = await addRule(app, owner, {
      label: "Lunch",
      amountSek: 100,
      cadence: "every_day",
      startDate: localDate(-9),
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/savings/rules/${id}`,
      headers: auth(stranger),
    });

    expect(response.statusCode).toBe(404);
    expect((await potOf(app, owner)).balanceSek).toBe(1000);
  });
});
