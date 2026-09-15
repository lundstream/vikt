import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { addDays } from "shared";
import { auth, createUser, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { foodItems } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

/**
 * Why a macro's weekly mean is missing, not only that it is (D122).
 *
 * Reported from the running app: fibre showed "Inte än" while protein,
 * carbohydrate and fat all rendered. The cause is D55's per-macro coverage
 * gate working exactly as designed — crowdsourced food data omits fibre far
 * more often than protein, so fewer than three days cleared 90 % and the mean
 * was correctly withheld.
 *
 * Correctly withheld and wrongly explained. "Inte än" cannot distinguish
 * "you have logged nothing" from "what you logged does not carry this figure",
 * and those call for different things from the reader. `weeklyDaysLogged`
 * carries the second number the interface needs to tell them apart.
 */

/**
 * A food carrying every macro, and one that omits fibre the way real
 * crowdsourced data does. Both are created through `/api/food/manual`, so the
 * entries below reference a real item rather than inventing macros inline.
 */
const COMPLETE = {
  name: "Fullständig mat",
  kcalPer100: 150,
  proteinPer100: 20,
  carbsPer100: 30,
  fatPer100: 10,
  fiberPer100: 5,
};

const NO_FIBRE = {
  name: "Mat utan fiberuppgift",
  kcalPer100: 150,
  proteinPer100: 20,
  carbsPer100: 30,
  fatPer100: 10,
};

/**
 * Inserted directly, because `/api/food/manual` takes a name, a calorie figure
 * and a brand and nothing else — the whole point of a manual entry is that
 * somebody is copying a packet, not filling in a nutrition table. A fixture
 * that needs per-macro coverage has to write the row.
 */
async function makeItem(
  db: Db,
  user: TestUser,
  item: typeof COMPLETE | typeof NO_FIBRE,
): Promise<string> {
  const [row] = await db
    .insert(foodItems)
    .values({
      source: "manual",
      name: item.name,
      createdBy: user.userId,
      visibility: "private",
      kcalPer100: String(item.kcalPer100),
      proteinPer100: String(item.proteinPer100),
      carbsPer100: String(item.carbsPer100),
      fatPer100: String(item.fatPer100),
      fiberPer100: "fiberPer100" in item ? String(item.fiberPer100) : null,
    })
    .returning({ id: foodItems.id });

  return row!.id;
}

async function logDay(
  app: FastifyInstance,
  user: TestUser,
  localDate: string,
  foodItemId: string,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/food-entry",
    headers: auth(user),
    payload: {
      clientUuid: randomUUID(),
      localDate,
      foodItemId,
      grams: 200,
      mealSlot: "lunch",
    },
  });
  if (response.statusCode >= 300) {
    throw new Error(`food entry failed (${response.statusCode}): ${response.body}`);
  }
}

/**
 * The macro block only exists once there is a target to compare against, which
 * needs a trend weight and a plan. That is D52's shape, not this test's: a
 * macro target is derived from an energy target, and an energy target is a
 * decision somebody made.
 */
async function withPlan(app: FastifyInstance, user: TestUser): Promise<void> {
  for (let back = 0; back < 10; back += 1) {
    await logWeight(app, user, 86 - back * 0.05, -back);
  }
  const plan = await app.inject({
    method: "POST",
    url: "/api/plans",
    headers: auth(user),
    payload: {
      name: "Testplan",
      startDate: addDays(new Date().toISOString().slice(0, 10), -13),
      targetIntakeKcal: 2000,
      intakeFloorKcal: 1500,
      goalWeightKg: 82,
    },
  });
  if (plan.statusCode >= 300) {
    throw new Error(`plan failed (${plan.statusCode}): ${plan.body}`);
  }
}

async function macros(app: FastifyInstance, user: TestUser) {
  const response = await app.inject({
    method: "GET",
    url: "/api/insights",
    headers: auth(user),
  });
  expect(response.statusCode).toBe(200);
  return response.json().macros;
}

describe("a withheld macro mean", () => {
  const ctx = useTestApp();

  /**
   * The reported shape: a week of real logging where three macros clear the
   * gate every day and fibre clears it on none.
   */
  it("separates 'nothing logged' from 'the entries carry no fibre'", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user);

    const today = new Date().toISOString().slice(0, 10);
    const item = await makeItem(db, user, NO_FIBRE);
    for (let back = 0; back < 5; back += 1) {
      await logDay(app, user, addDays(today, -back), item);
    }

    const lines = await macros(app, user);

    // The three that carry data average normally.
    for (const key of ["protein", "carbs", "fat"]) {
      expect(lines[key].weeklyMeanG, `${key} should have a mean`).not.toBeNull();
    }

    // Fibre does not, and the counts say why: days were logged, and no food in
    // any of them carries fibre (D55, addendum 2026-09-15: a partial day now
    // contributes, so this is the only way days can be logged and no mean shown).
    expect(lines.fiber.weeklyMeanG).toBeNull();
    expect(lines.fiber.weeklyComplete).toBe(false);
    expect(lines.fiber.weeklyDaysLogged, "days were logged, fibre just was not in them")
      .toBe(5);
  });

  /**
   * The case the old gate hid: some days carry fibre and some do not. The mean
   * is there, built from the known grams, and it is marked as a floor.
   */
  it("shows a floor, not nothing, when only some days carry fibre", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user);

    const today = new Date().toISOString().slice(0, 10);
    const complete = await makeItem(db, user, COMPLETE);
    const noFibre = await makeItem(db, user, NO_FIBRE);
    for (let back = 0; back < 5; back += 1) {
      await logDay(app, user, addDays(today, -back), back < 2 ? complete : noFibre);
    }

    const lines = await macros(app, user);
    // 200 g at 5 g per 100 g is 10 g on each of two days, over five logged days.
    expect(lines.fiber.weeklyMeanG).toBeCloseTo(4, 6);
    expect(lines.fiber.weeklyComplete).toBe(false);
    expect(lines.fiber.weeklyPartialDays).toBe(3);
    expect(lines.fiber.weeklyCoverage).toBeCloseTo(0.4, 6);
    expect(lines.protein.weeklyComplete).toBe(true);
  });

  /** The other reason, which must not be reported as the first one. */
  it("reports an empty week as empty", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user);

    const lines = await macros(app, user);

    for (const key of ["protein", "carbs", "fat", "fiber"]) {
      expect(lines[key].weeklyMeanG).toBeNull();
      expect(lines[key].weeklyDaysLogged, `${key} should show an empty week`).toBe(0);
    }
  });

  /**
   * And the gate itself still holds: enough complete days and the mean appears.
   * Without this the test above would pass on a build that never averages
   * anything.
   */
  it("shows the mean once enough days carry the figure", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user);

    const today = new Date().toISOString().slice(0, 10);
    const item = await makeItem(db, user, COMPLETE);
    for (let back = 0; back < 4; back += 1) {
      await logDay(app, user, addDays(today, -back), item);
    }

    const lines = await macros(app, user);
    expect(lines.fiber.weeklyMeanG).not.toBeNull();
    expect(lines.fiber.weeklyDays).toBeGreaterThanOrEqual(3);
    expect(lines.fiber.weeklyDaysLogged).toBe(lines.fiber.weeklyDays);
    expect(lines.fiber.weeklyComplete).toBe(true);
  });
});
