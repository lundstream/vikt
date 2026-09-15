import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, logWeight, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Macro targets from NNR 2023 (D52), at the API boundary.
 *
 * `calc/macros.test.ts` pins the arithmetic. These pin the things only the
 * endpoint can be wrong about: that the targets follow the plan rather than
 * being stored, that an override reaches the payload without erasing the figure
 * it replaced, and that a day of half-labelled food is reported as *partial*
 * rather than as a low total.
 */

type Entry = {
  kcal: number;
  proteinG?: number;
  carbsG?: number;
  fatG?: number;
  fiberG?: number;
};

async function logFood(
  app: FastifyInstance,
  user: TestUser,
  entry: Entry,
  offset = 0,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/food-entry",
    headers: auth(user),
    payload: {
      clientUuid: randomUUID(),
      localDate: localDate(offset),
      // Freetext, so the macros are exactly what this test says they are rather
      // than whatever a food item would scale to.
      freetext: "Testmat",
      grams: 100,
      mealSlot: "lunch",
      ...entry,
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`food entry failed (${response.statusCode}): ${response.body}`);
  }
}

async function withPlan(
  app: FastifyInstance,
  user: TestUser,
  targetIntakeKcal: number,
  weightKg = 92,
): Promise<void> {
  await logWeight(app, user, weightKg);
  const response = await app.inject({
    method: "POST",
    url: `/api/plans?asOf=${localDate()}`,
    headers: auth(user),
    payload: {
      name: "Plan",
      startDate: localDate(-7),
      targetIntakeKcal,
      intakeFloorKcal: 1200,
      goalWeightKg: 85,
    },
  });
  if (response.statusCode !== 201 && response.statusCode !== 200) {
    throw new Error(`plan failed (${response.statusCode}): ${response.body}`);
  }
}

const insights = (app: FastifyInstance, user: TestUser) =>
  app.inject({
    method: "GET",
    url: `/api/insights?asOf=${localDate()}`,
    headers: auth(user),
  });

describe("macro targets", () => {
  it("is absent without a plan, since every figure is derived from its target", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 92);

    expect((await insights(app, user)).json().macros).toBeNull();
  });

  it("derives targets from the plan and follows it when the plan changes", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 92);

    const created = await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(user),
      payload: {
        name: "Plan",
        startDate: localDate(-7),
        targetIntakeKcal: 2600,
        intakeFloorKcal: 1200,
        goalWeightKg: 85,
      },
    });
    expect(created.statusCode).toBe(201);

    const before = (await insights(app, user)).json().macros;
    expect(before.fat.targetG).toBeGreaterThan(0);

    // The same plan, tightened. Nothing stored the first set of grams, so the
    // targets have to move on their own.
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/plans/${created.json().id}?asOf=${localDate()}`,
      headers: auth(user),
      payload: { targetIntakeKcal: 2200 },
    });
    expect(edited.statusCode).toBe(200);

    const after = (await insights(app, user)).json().macros;
    expect(after.fat.targetG).toBeLessThan(before.fat.targetG);
    expect(after.carbs.targetG).toBeLessThan(before.carbs.targetG);
  });

  /** The constraint from the source that a flat 15 E% would get wrong. */
  it("raises protein onto the g/kg floor below 8 MJ, and says which rule applied", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 1600, 92);

    const macros = (await insights(app, user)).json().macros;
    expect(macros.belowLowEnergyThreshold).toBe(true);
    expect(macros.proteinBasis).toBe("per_kg");
    // 0.83 g/kg of a 92 kg trend, not 15% of 1600 kcal.
    expect(macros.protein.targetG).toBe(76);
  });

  it("uses the energy percentage above 8 MJ", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2600, 92);

    const macros = (await insights(app, user)).json().macros;
    expect(macros.belowLowEnergyThreshold).toBe(false);
    expect(macros.proteinBasis).toBe("energy_percent");
    expect(macros.protein.targetG).toBeGreaterThan(76);
  });
});

/**
 * The hazard the coverage figure exists for: a total that looks like an answer
 * and is quietly missing a third of the day.
 */
describe("macro coverage", () => {
  it("marks a total incomplete when part of the day carried no macros", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);

    await logFood(app, user, { kcal: 600, proteinG: 40, carbsG: 50, fatG: 20 });
    // The unlabelled dinner. Its calories count; its macros are unknown.
    await logFood(app, user, { kcal: 800 });

    const macros = (await insights(app, user)).json().macros;

    expect(macros.protein.todayG).toBe(40);
    expect(macros.protein.todayCoverage).toBeCloseTo(600 / 1400, 3);
    expect(macros.protein.todayComplete).toBe(false);
  });

  it("reports a fully labelled day as complete", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);

    await logFood(app, user, { kcal: 600, proteinG: 40, carbsG: 50, fatG: 20, fiberG: 6 });
    await logFood(app, user, { kcal: 800, proteinG: 30, carbsG: 90, fatG: 25, fiberG: 4 });

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.todayCoverage).toBe(1);
    expect(macros.protein.todayComplete).toBe(true);
    expect(macros.fiber.todayG).toBe(10);
  });

  it("gives null rather than 0 for a macro no entry carried", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);
    await logFood(app, user, { kcal: 600, proteinG: 40 });

    const macros = (await insights(app, user)).json().macros;
    expect(macros.fiber.todayG).toBeNull();
    expect(macros.fiber.todayCoverage).toBe(0);
  });

  it("says nothing was logged rather than showing a zero day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);

    const body = (await insights(app, user)).json();
    expect(body.todayIntakeKcal).toBeNull();
    // Not 2000. "2 000 left" on an empty day is an absence dressed as a result.
    expect(body.todayRemainingKcal).toBeNull();
    expect(body.macros.protein.todayG).toBeNull();
  });

  it("counts a manual intake day as protein-only, not as zero carbohydrate", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);

    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        kcal: 1800,
        proteinG: 110,
      },
    });

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.todayG).toBe(110);
    expect(macros.protein.todayComplete).toBe(true);
    expect(macros.carbs.todayG).toBeNull();
    expect(macros.carbs.todayComplete).toBe(false);
  });
});

/**
 * NNR's values refer to average intake over at least a week, which is the only
 * comparison the UI is allowed to make.
 */
describe("the weekly average", () => {
  /**
   * D55, addendum 2026-09-15. The half-labelled day used to be dropped so it
   * could not drag the mean down as if intake were low. It contributes its
   * known 20 g now, and the mean is marked as a floor instead of hidden.
   */
  it("averages every logged day's known grams, and marks the mean as a floor", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);

    for (const offset of [0, -1, -2]) {
      await logFood(app, user, { kcal: 1500, proteinG: 100, carbsG: 150, fatG: 50 }, offset);
    }
    await logFood(app, user, { kcal: 900, proteinG: 20 }, -3);
    await logFood(app, user, { kcal: 900 }, -3);

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.weeklyDays).toBe(4);
    expect(macros.protein.weeklyMeanG).toBe((100 * 3 + 20) / 4);
    expect(macros.protein.weeklyComplete).toBe(false);
    expect(macros.protein.weeklyPartialDays).toBe(1);
    expect(macros.protein.weeklyCoverage).toBeCloseTo((4500 + 900) / (4500 + 1800), 3);
  });

  it("is a plain mean when every day was complete, and absent where no food carries it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);

    for (const offset of [0, -1, -2]) {
      await logFood(app, user, { kcal: 1500, proteinG: 100, carbsG: 150, fatG: 50 }, offset);
    }

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.weeklyMeanG).toBe(100);
    expect(macros.protein.weeklyComplete).toBe(true);
    expect(macros.protein.weeklyCoverage).toBe(1);
    // Three logged days, and not one entry carrying fibre: nothing to state.
    expect(macros.fiber.weeklyMeanG).toBeNull();
    expect(macros.fiber.weeklyDaysLogged).toBe(3);
  });

  it("has no average from one day, which is not a week", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2000);
    await logFood(app, user, { kcal: 1500, proteinG: 100, carbsG: 150, fatG: 50 });

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.weeklyDays).toBe(1);
    expect(macros.protein.weeklyMeanG).toBeNull();
  });
});

describe("overrides", () => {
  it("replaces the target and keeps the derived figure beside it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2600, 92);

    const derived = (await insights(app, user)).json().macros.protein.derivedG;

    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { macroProteinG: 150 },
    });

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.targetG).toBe(150);
    expect(macros.protein.overridden).toBe(true);
    // Still there, which is what makes the way back showable.
    expect(macros.protein.derivedG).toBe(derived);
    // Untouched macros are still NNR's.
    expect(macros.fat.overridden).toBe(false);
  });

  it("is cleared by an explicit null, restoring the derived value", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await withPlan(app, user, 2600, 92);

    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { macroProteinG: 150 },
    });
    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { macroProteinG: null },
    });

    const macros = (await insights(app, user)).json().macros;
    expect(macros.protein.overridden).toBe(false);
    expect(macros.protein.targetG).toBe(macros.protein.derivedG);
  });
});

describe("bmi", () => {
  it("comes from the trend, not the last reading", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logWeight(app, user, 92, -3);
    await logWeight(app, user, 92, -2);
    await logWeight(app, user, 92, -1);
    // A dehydrated morning. BMI must barely move.
    await logWeight(app, user, 88, 0);

    const body = (await insights(app, user)).json();
    // 88 kg at 180 cm is 27.2; the trend is still near 92, which is 28.4.
    expect(body.bmi).toBeGreaterThan(28);
  });

  it("is absent with no readings", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    expect((await insights(app, user)).json().bmi).toBeNull();
  });
});
