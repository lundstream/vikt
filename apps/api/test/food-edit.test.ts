import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Correcting a logged food entry, and editing a saved meal.
 *
 * §3 says every user-created row ships with an edit and a delete in the phase
 * that creates it (D56). A food entry is many-per-day, so re-logging is not an
 * edit — it makes a second row — and the only way to fix 250 g typed for 150
 * was to delete and start again, losing the time it was logged at.
 */

async function manualFood(
  app: FastifyInstance,
  user: TestUser,
  kcalPer100: number,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/food/manual",
    headers: auth(user),
    payload: { name: "Testmat", kcalPer100 },
  });
  return response.json<{ id: string }>().id;
}

async function logEntry(
  app: FastifyInstance,
  user: TestUser,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/food-entry",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(), grams: 100, ...payload },
  });
  if (response.statusCode !== 200) {
    throw new Error(`entry failed (${response.statusCode}): ${response.body}`);
  }
  return response.json();
}

const entriesOf = async (app: FastifyInstance, user: TestUser) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/food-entry?from=${localDate()}&to=${localDate()}`,
      headers: auth(user),
    })
  ).json().entries;

describe("editing a food entry", () => {
  it("rescales the energy from the food item", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, 350);

    const entry = await logEntry(app, user, { foodItemId, grams: 250 });
    expect(entry.kcal).toBe(875);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${entry.id}`,
      headers: auth(user),
      payload: { grams: 150 },
    });

    expect(response.statusCode).toBe(200);
    // 150 g of a 350 kcal/100 g food, recomputed rather than left at 875.
    expect(response.json().kcal).toBe(525);
    expect(response.json().grams).toBe(150);
  });

  it("moves the day's total with it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, 100);
    const entry = await logEntry(app, user, { foodItemId, grams: 500 });

    const before = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json().todayIntakeKcal;
    expect(before).toBe(500);

    await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${entry.id}`,
      headers: auth(user),
      payload: { grams: 200 },
    });

    const after = (
      await app.inject({
        method: "GET",
        url: `/api/insights?asOf=${localDate()}`,
        headers: auth(user),
      })
    ).json().todayIntakeKcal;
    expect(after).toBe(200);
  });

  /**
   * A freetext entry has no item to read, so its own figures scale by the ratio
   * of the amounts. They were the user's estimate for a portion, and half the
   * portion is half the estimate.
   */
  it("scales a freetext entry's own numbers", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const entry = await logEntry(app, user, {
      freetext: "Gryta",
      grams: 400,
      kcal: 600,
      proteinG: 40,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${entry.id}`,
      headers: auth(user),
      payload: { grams: 200 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().kcal).toBe(300);
    expect(response.json().proteinG).toBe(20);
  });

  it("leaves an absent macro absent rather than making it zero", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const entry = await logEntry(app, user, { freetext: "Kaffe", grams: 200, kcal: 40 });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${entry.id}`,
      headers: auth(user),
      payload: { grams: 100 },
    });

    expect(response.json().kcal).toBe(20);
    expect(response.json().proteinG).toBeNull();
  });

  it("can move a row to another meal", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const entry = await logEntry(app, user, {
      freetext: "Smörgås",
      kcal: 200,
      mealSlot: "breakfast",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${entry.id}`,
      headers: auth(user),
      payload: { grams: 100, mealSlot: "lunch" },
    });

    expect(response.json().mealSlot).toBe("lunch");
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const entry = await logEntry(app, owner, { freetext: "Gryta", kcal: 600 });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${entry.id}`,
      headers: auth(stranger),
      payload: { grams: 1 },
    });

    expect(response.statusCode).toBe(404);
    expect((await entriesOf(app, owner))[0].kcal).toBe(600);
  });
});

describe("saved meals", () => {
  async function saveMeal(app: FastifyInstance, user: TestUser, name: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/meal-templates",
      headers: auth(user),
      payload: {
        name,
        items: [{ nameSnapshot: "Havregryn", freetext: "Havregryn", grams: 60 }],
      },
    });
    if (response.statusCode !== 201 && response.statusCode !== 200) {
      throw new Error(`template failed (${response.statusCode}): ${response.body}`);
    }
    return response.json<{ id: string }>().id;
  }

  it("can be renamed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await saveMeal(app, user, "Frukost");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/meal-templates/${id}`,
      headers: auth(user),
      payload: { name: "Vardagsfrukost" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("Vardagsfrukost");
  });

  it("can be deleted", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = await saveMeal(app, user, "Frukost");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/meal-templates/${id}`,
      headers: auth(user),
    });

    expect(response.statusCode).toBe(204);

    const list = (
      await app.inject({ method: "GET", url: "/api/meal-templates", headers: auth(user) })
    ).json().templates;
    expect(list).toHaveLength(0);
  });

  it("is scoped to the caller", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const id = await saveMeal(app, owner, "Frukost");

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/meal-templates/${id}`,
          headers: auth(stranger),
        })
      ).statusCode,
    ).toBe(404);

    // The scoping was never the problem; reporting success for a no-op was.
    const list = (
      await app.inject({ method: "GET", url: "/api/meal-templates", headers: auth(owner) })
    ).json().templates;
    expect(list).toHaveLength(1);
  });
});
