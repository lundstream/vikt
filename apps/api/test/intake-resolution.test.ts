import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * A day's intake is the manual row if there is one, otherwise the sum of that
 * day's food entries, otherwise absent.
 *
 * That rule has been in `calc/intake.ts` since Phase 2. What was missing until
 * now was any call site that assembled both halves: all four passed `manual`
 * only, so a day with a full food log counted as a day nobody logged. These
 * tests are at the API boundary rather than on the resolver, because the
 * resolver was never the thing that was wrong.
 */

async function logFood(
  app: FastifyInstance,
  user: TestUser,
  kcal: number,
  offset = 0,
): Promise<void> {
  // A 100 kcal/100 g food scaled by grams, so any total is reachable without
  // inventing a food denser than the schema allows.
  const item = await app.inject({
    method: "POST",
    url: "/api/food/manual",
    headers: auth(user),
    payload: { name: "Testmat", kcalPer100: 100 },
  });
  if (item.statusCode !== 200 && item.statusCode !== 201) {
    throw new Error(`food item failed (${item.statusCode}): ${item.body}`);
  }

  const response = await app.inject({
    method: "POST",
    url: "/api/food-entry",
    headers: auth(user),
    payload: {
      clientUuid: randomUUID(),
      localDate: localDate(offset),
      foodItemId: item.json<{ id: string }>().id,
      grams: kcal,
      mealSlot: "lunch",
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`food entry failed (${response.statusCode}): ${response.body}`);
  }
}

const logIntake = (app: FastifyInstance, user: TestUser, kcal: number, offset = 0) =>
  app.inject({
    method: "POST",
    url: "/api/manual-intake",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(offset), kcal },
  });

const insightsFor = async (app: FastifyInstance, user: TestUser) =>
  (
    await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
  ).json<{
    todayIntakeKcal: number | null;
    maintenance: { source: string; coverage: number; tdee: number | null };
  }>();

describe("a day logged only with food entries", () => {
  /** The reported symptom: "Inte än" on a day with a full food log. */
  it("is reported as today's intake", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logFood(app, user, 700);

    expect((await insightsFor(app, user)).todayIntakeKcal).toBe(700);
  });

  /**
   * The consequence that matters more, because it is invisible: those days
   * were excluded from the §4.2 coverage gate, so enough of them and
   * maintenance silently falls back to the formula despite daily logging.
   */
  it("counts as logged in the coverage gate", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // A full 35-day window: a weight every day, and intake every day, but
    // logged as food entries rather than as a manual row.
    for (let day = 34; day >= 0; day--) {
      await logWeight(app, user, 88 - (34 - day) * 0.02, -day);
      await logFood(app, user, 2100, -day);
    }

    const insights = await insightsFor(app, user);

    expect(insights.maintenance.coverage).toBeGreaterThan(0.99);
    expect(insights.maintenance.source).toBe("adaptive");
  });

  it("contributes its calories to the mean intake", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (let day = 34; day >= 0; day--) {
      await logWeight(app, user, 88, -day);
      await logFood(app, user, 2000, -day);
    }

    const insights = await insightsFor(app, user);

    // A flat weight series means no energy term, so maintenance is the mean
    // intake itself. If food days were excluded there would be no figure at all.
    expect(insights.maintenance.tdee).not.toBeNull();
    expect(insights.maintenance.tdee!).toBeCloseTo(2000, 0);
  });

  it("sums several entries on one day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logFood(app, user, 300);
    await logFood(app, user, 450);

    expect((await insightsFor(app, user)).todayIntakeKcal).toBe(750);
  });
});

describe("precedence between the two sources", () => {
  /**
   * The manual row is the deliberate override, so it **replaces** the day's
   * food entries rather than adding to them. Adding would double-count the
   * meals someone logged and then corrected with a single figure.
   */
  it("lets a manual row override the day's food entries", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logFood(app, user, 700);
    await logIntake(app, user, 2200);

    const intake = (await insightsFor(app, user)).todayIntakeKcal;

    expect(intake).toBe(2200);
    expect(intake).not.toBe(2900);
  });

  it("falls back to food entries on days with no manual row", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logFood(app, user, 700, -1);
    await logIntake(app, user, 2200, 0);

    // Today has the manual row; yesterday only food. Both count as logged.
    expect((await insightsFor(app, user)).todayIntakeKcal).toBe(2200);
  });

  /** Absent stays absent: no rows of either kind is not a day of zero. */
  it("is null on a day with neither", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 88);

    expect((await insightsFor(app, user)).todayIntakeKcal).toBeNull();
  });

  it("keeps a logged zero distinct from nothing logged", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logIntake(app, user, 0);

    expect((await insightsFor(app, user)).todayIntakeKcal).toBe(0);
  });

  it("keeps one user's intake out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    await logFood(app, mine, 700);

    expect((await insightsFor(app, theirs)).todayIntakeKcal).toBeNull();
  });
});

/**
 * §3: every user-created row ships with a delete. `manual_intake` had none, and
 * because a manual row **owns its day**, that gap was not cosmetic: a rough
 * total typed in the morning silently outranked every meal logged after it, and
 * the only way out was to overwrite it with another guess.
 */
describe("removing a manual intake row", () => {
  it("hands the day back to its food entries", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logFood(app, user, 1500);
    await logIntake(app, user, 800);

    // Manual wins while it is there.
    expect((await insightsFor(app, user)).todayIntakeKcal).toBe(800);

    const [row] = (
      await app.inject({ method: "GET", url: "/api/manual-intake", headers: auth(user) })
    ).json().entries;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/manual-intake/${row.id}`,
      headers: auth(user),
    });

    expect(response.statusCode).toBe(204);
    expect((await insightsFor(app, user)).todayIntakeKcal).toBe(1500);
  });

  it("leaves a day with no food entries absent, not zero", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logIntake(app, user, 800);

    const [row] = (
      await app.inject({ method: "GET", url: "/api/manual-intake", headers: auth(user) })
    ).json().entries;

    await app.inject({
      method: "DELETE",
      url: `/api/manual-intake/${row.id}`,
      headers: auth(user),
    });

    expect((await insightsFor(app, user)).todayIntakeKcal).toBeNull();
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    await logIntake(app, owner, 800);

    const [row] = (
      await app.inject({ method: "GET", url: "/api/manual-intake", headers: auth(owner) })
    ).json().entries;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/manual-intake/${row.id}`,
      headers: auth(stranger),
    });

    expect(response.statusCode).toBe(404);
    expect((await insightsFor(app, owner)).todayIntakeKcal).toBe(800);
  });
});
