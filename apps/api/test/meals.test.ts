import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { exportColumnName, type Meal } from "shared";
import type { Db } from "../src/db/index.js";
import { foodEntries, foodItems } from "../src/db/schema.js";
import { deriveUuid } from "../src/lib/derive-uuid.js";
import { upgradeLegacyTables } from "../src/lib/legacy-export.js";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Måltider (Phase 14, D186): a dish with a portion count, logged as ordinary
 * food rows that are their own snapshot.
 */

type Food = {
  name: string;
  kcal: number;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  fiber?: number | null;
  owner?: string;
};

async function food(db: Db, spec: Food): Promise<string> {
  const [row] = await db
    .insert(foodItems)
    .values({
      source: "manual",
      name: spec.name,
      kcalPer100: String(spec.kcal),
      proteinPer100: spec.protein == null ? null : String(spec.protein),
      carbsPer100: spec.carbs == null ? null : String(spec.carbs),
      fatPer100: spec.fat == null ? null : String(spec.fat),
      fiberPer100: spec.fiber == null ? null : String(spec.fiber),
      visibility: spec.owner ? "private" : "shared",
      createdBy: spec.owner ?? null,
    })
    .returning({ id: foodItems.id });
  return row!.id;
}

async function create(app: FastifyInstance, user: TestUser, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/meals",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), ...payload },
  });
}

/** A four-portion stew: 800 g of mince and 400 g of tomatoes. */
async function stew(app: FastifyInstance, db: Db, user: TestUser) {
  const mince = await food(db, { name: "Köttfärs", kcal: 200, protein: 20, carbs: 0, fat: 13, fiber: 0 });
  const tomato = await food(db, { name: "Krossade tomater", kcal: 25, protein: 1, carbs: 4, fat: 0.2, fiber: 1 });
  const response = await create(app, user, {
    name: "Köttfärssås",
    portions: 4,
    items: [
      { foodItemId: mince, nameSnapshot: "Köttfärs", amount: 800, unit: "g", grams: 800 },
      { foodItemId: tomato, nameSnapshot: "Krossade tomater", amount: 1, unit: "paket", grams: 400 },
    ],
  });
  expect(response.statusCode).toBe(201);
  return { meal: response.json<Meal>(), mince, tomato };
}

const entriesOn = async (app: FastifyInstance, user: TestUser, day = localDate()) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/food-entry?from=${day}&to=${day}`,
      headers: auth(user),
    })
  ).json().entries as {
    id: string;
    name: string;
    grams: number;
    kcal: number;
    proteinG: number | null;
    mealId: string | null;
    mealLogUuid: string | null;
    mealName: string | null;
    mealPortions: number | null;
  }[];

async function logIt(
  app: FastifyInstance,
  user: TestUser,
  mealId: string,
  body: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/meals/${mealId}/log`,
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(), portions: 1, ...body },
  });
}

describe("a meal", () => {
  it("carries its figures per portion, from the shared calc", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal } = await stew(app, db, user);

    // 1 600 + 100 kcal over four portions.
    expect(meal.portions).toBe(4);
    expect(meal.perPortion.kcal).toBeCloseTo(425);
    expect(meal.perPortion.kcalComplete).toBe(true);
    expect(meal.perPortion.protein.grams).toBeCloseTo((160 + 4) / 4);
    expect(meal.perPortion.protein.complete).toBe(true);
    expect(meal.items.map((item) => [item.amount, item.unit, item.grams])).toEqual([
      [800, "g", 800],
      [1, "paket", 400],
    ]);
  });

  it("says minst when a row carries no figure for a macro (D55)", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const bread = await food(db, { name: "Bröd", kcal: 250, protein: 8, fiber: null });
    const butter = await food(db, { name: "Smör", kcal: 740, protein: 0.5, fiber: 0 });
    const meal = (
      await create(app, user, {
        name: "Smörgås",
        items: [
          { foodItemId: bread, nameSnapshot: "Bröd", amount: 2, unit: "skivor", grams: 70 },
          { foodItemId: butter, nameSnapshot: "Smör", amount: 10, unit: "g", grams: 10 },
        ],
      })
    ).json<Meal>();

    // Bread is 175 of 249 kcal and carries no fibre: 30 % covered.
    expect(meal.perPortion.fiber.complete).toBe(false);
    expect(meal.perPortion.fiber.coverage).toBeCloseTo(74 / 249, 3);
    expect(meal.perPortion.protein.complete).toBe(true);
  });

  it("is created once, however many times the create is sent (§3)", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const oats = await food(db, { name: "Havregryn", kcal: 370 });
    const payload = {
      clientUuid: randomUUID(),
      name: "Gröt",
      items: [{ foodItemId: oats, nameSnapshot: "Havregryn", amount: 1, unit: "dl", grams: 35 }],
    };

    const first = await create(app, user, payload);
    const second = await create(app, user, payload);
    expect(second.json<Meal>().id).toBe(first.json<Meal>().id);

    const list = (await app.inject({ method: "GET", url: "/api/meals", headers: auth(user) })).json();
    expect(list.meals).toHaveLength(1);
    expect(list.meals[0].items).toHaveLength(1);
  });

  it("edits its name, portions and rows, and removes (D56)", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal, mince } = await stew(app, db, user);

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/meals/${meal.id}`,
      headers: auth(user),
      payload: {
        name: "Bolognese",
        portions: 2,
        items: [{ foodItemId: mince, nameSnapshot: "Köttfärs", amount: 500, unit: "g", grams: 500 }],
      },
    });
    expect(edited.statusCode).toBe(200);
    const after = edited.json<Meal>();
    expect(after.name).toBe("Bolognese");
    expect(after.items).toHaveLength(1);
    expect(after.perPortion.kcal).toBeCloseTo(500);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/meals/${meal.id}`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(204);
    const list = (await app.inject({ method: "GET", url: "/api/meals", headers: auth(user) })).json();
    expect(list.meals).toEqual([]);
  });

  it("refuses zero portions", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const oats = await food(db, { name: "Havregryn", kcal: 370 });
    const response = await create(app, user, {
      name: "Gröt",
      portions: 0,
      items: [{ foodItemId: oats, nameSnapshot: "Havregryn", amount: 1, unit: "dl", grams: 35 }],
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("logging a meal", () => {
  it("writes ordinary rows scaled per portion, carrying the meal's name", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal } = await stew(app, db, user);

    const response = await logIt(app, user, meal.id, { portions: 1.5, mealSlot: "dinner" });
    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toEqual([]);

    const rows = await entriesOn(app, user);
    expect(rows).toHaveLength(2);
    // 1,5 of 4 portions is three eighths of every row.
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]));
    expect(byName["Köttfärs"]!.grams).toBe(300);
    expect(byName["Köttfärs"]!.kcal).toBe(600);
    expect(byName["Krossade tomater"]!.grams).toBe(150);
    for (const row of rows) {
      expect(row.mealId).toBe(meal.id);
      expect(row.mealName).toBe("Köttfärssås");
      expect(row.mealPortions).toBe(1.5);
      expect(row.mealLogUuid).toBe(rows[0]!.mealLogUuid);
    }
  });

  it("is idempotent on the logging, and counts it once", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal } = await stew(app, db, user);
    const body = { clientUuid: randomUUID(), localDate: localDate(), portions: 1 };

    await logIt(app, user, meal.id, body);
    await logIt(app, user, meal.id, body);
    expect(await entriesOn(app, user)).toHaveLength(2);

    await logIt(app, user, meal.id);
    expect(await entriesOn(app, user)).toHaveLength(4);

    const fetched = (
      await app.inject({ method: "GET", url: `/api/meals/${meal.id}`, headers: auth(user) })
    ).json<Meal>();
    expect(fetched.loggedCount).toBe(2);
    expect(fetched.recentLogs).toBe(2);
  });

  it("derives each row's key from the logging and the row's place", () => {
    const base = randomUUID();
    expect(deriveUuid(base, 0)).toBe(deriveUuid(base, 0));
    expect(deriveUuid(base, 0)).not.toBe(deriveUuid(base, 1));
    expect(deriveUuid(base, 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("leaves logged days alone when the meal is edited or removed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal, mince } = await stew(app, db, user);
    await logIt(app, user, meal.id, { portions: 1 });
    const before = await entriesOn(app, user);

    await app.inject({
      method: "PATCH",
      url: `/api/meals/${meal.id}`,
      headers: auth(user),
      payload: {
        name: "Något annat",
        portions: 1,
        items: [{ foodItemId: mince, nameSnapshot: "Köttfärs", amount: 50, unit: "g", grams: 50 }],
      },
    });
    const edited = await entriesOn(app, user);
    expect(edited.map((row) => [row.name, row.grams, row.kcal, row.mealName])).toEqual(
      before.map((row) => [row.name, row.grams, row.kcal, row.mealName]),
    );

    await app.inject({ method: "DELETE", url: `/api/meals/${meal.id}`, headers: auth(user) });
    const removed = await entriesOn(app, user);
    expect(removed).toHaveLength(2);
    expect(removed.every((row) => row.mealName === "Köttfärssås" && row.mealId === null)).toBe(true);
  });

  it("keeps a logged row editable and removable like any row, and in its meal", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal } = await stew(app, db, user);
    await logIt(app, user, meal.id, { portions: 1 });
    const [first] = await entriesOn(app, user);

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/food-entry/${first!.id}`,
      headers: auth(user),
      payload: { grams: 250 },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().mealName).toBe("Köttfärssås");
    expect(edited.json().grams).toBe(250);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/food-entry/${first!.id}`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(204);
    expect(await entriesOn(app, user)).toHaveLength(1);
  });

  it("skips a row whose food is gone, and says which (D17)", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { meal, tomato } = await stew(app, db, user);
    await db.delete(foodItems).where(eq(foodItems.id, tomato));

    const fetched = (
      await app.inject({ method: "GET", url: `/api/meals/${meal.id}`, headers: auth(user) })
    ).json<Meal>();
    expect(fetched.items[1]!.name).toBe("Krossade tomater");
    expect(fetched.items[1]!.food).toBeNull();
    expect(fetched.perPortion.kcalComplete).toBe(false);

    const logged = await logIt(app, user, meal.id);
    expect(logged.json().skipped).toEqual(["Krossade tomater"]);
    expect(await entriesOn(app, user)).toHaveLength(1);
  });

  it("orders the list by loggings in the last ninety days, then by the last one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const oats = await food(db, { name: "Havregryn", kcal: 370 });
    const item = { foodItemId: oats, nameSnapshot: "Havregryn", amount: 1, unit: "dl", grams: 35 };
    const ids: Record<string, string> = {};
    for (const name of ["Sällan", "Ofta", "Gammal vana"]) {
      ids[name] = (await create(app, user, { name, items: [item] })).json<Meal>().id;
    }
    await logIt(app, user, ids["Ofta"]!);
    await logIt(app, user, ids["Ofta"]!);
    await logIt(app, user, ids["Sällan"]!);
    // Logged often, but long ago: outside the window, it counts for nothing.
    for (let i = 0; i < 3; i += 1) await logIt(app, user, ids["Gammal vana"]!);
    await db
      .update(foodEntries)
      .set({ loggedAt: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) })
      .where(eq(foodEntries.mealId, ids["Gammal vana"]!));

    const list = (await app.inject({ method: "GET", url: "/api/meals", headers: auth(user) })).json();
    expect(list.meals.map((meal: Meal) => [meal.name, meal.recentLogs])).toEqual([
      ["Ofta", 2],
      ["Sällan", 1],
      ["Gammal vana", 0],
    ]);
  });
});

describe("meals and isolation (§3)", () => {
  it("keeps one person's meals from another at every endpoint", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const { meal } = await stew(app, db, owner);

    const list = (await app.inject({ method: "GET", url: "/api/meals", headers: auth(stranger) })).json();
    expect(list.meals).toEqual([]);

    for (const [method, url, payload] of [
      ["GET", `/api/meals/${meal.id}`, undefined],
      ["PATCH", `/api/meals/${meal.id}`, { name: "Min nu" }],
      ["DELETE", `/api/meals/${meal.id}`, undefined],
      ["POST", `/api/meals/${meal.id}/log`, { clientUuid: randomUUID(), localDate: localDate(), portions: 1 }],
    ] as const) {
      const response = await app.inject({ method, url, headers: auth(stranger), payload });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    const still = (
      await app.inject({ method: "GET", url: `/api/meals/${meal.id}`, headers: auth(owner) })
    ).json<Meal>();
    expect(still.name).toBe("Köttfärssås");
    expect(await entriesOn(app, stranger)).toEqual([]);
  });

  it("refuses a row that names somebody else's private food", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const secret = await food(db, { name: "Mormors sås", kcal: 300, owner: owner.userId });

    const response = await create(app, stranger, {
      name: "Stulen",
      items: [{ foodItemId: secret, nameSnapshot: "x", amount: 1, unit: "g", grams: 100 }],
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("meals in the export (D96)", () => {
  it("travels in the export and reads back into a fresh account, grouped as it was", async () => {
    const { app, db } = ctx();
    const source = await createUser(app, db);
    const { meal } = await stew(app, db, source);
    await logIt(app, source, meal.id, { portions: 1.5 });

    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(source) })
    ).json();
    expect(file.tables.meals).toHaveLength(1);
    expect(file.tables.meal_items).toHaveLength(2);
    for (const table of ["meals", "meal_items", "food_entries"]) {
      for (const column of Object.keys(file.tables[table][0])) {
        expect(exportColumnName(column), `${table}.${column}`).not.toBeNull();
      }
    }

    const target = await createUser(app, db);
    const imported = await app.inject({
      method: "POST",
      url: "/api/import/json",
      headers: auth(target),
      payload: file,
    });
    expect(imported.statusCode, imported.body).toBe(200);

    const meals = (await app.inject({ method: "GET", url: "/api/meals", headers: auth(target) })).json()
      .meals as Meal[];
    expect(meals).toHaveLength(1);
    expect(meals[0]!.id).not.toBe(meal.id);
    expect(meals[0]!.perPortion.kcal).toBeCloseTo(meal.perPortion.kcal!);
    const rows = await entriesOn(app, target);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.mealId === meals[0]!.id && row.mealPortions === 1.5)).toBe(true);
  });

  it("reads an export from before 1.3, with templates, as meals", () => {
    const upgraded = upgradeLegacyTables({
      meal_templates: [
        {
          id: "t1",
          user_id: "u",
          name: "Frukost",
          default_meal_slot: "breakfast",
          use_count: 4,
          last_used_at: "2026-09-01T07:00:00Z",
          created_at: "2026-08-01T07:00:00Z",
        },
      ],
      meal_template_items: [
        { id: "i1", template_id: "t1", food_item_id: "f", name_snapshot: "", freetext: "fil", grams: "200.0", position: 0 },
      ],
      saved_recipes: [{ id: "r", title: "Fil", template_id: "t1" }],
    });

    expect(upgraded.meal_templates).toBeUndefined();
    expect(upgraded.meals).toEqual([
      expect.objectContaining({ id: "t1", client_uuid: "t1", portions: 1, logged_count: 4 }),
    ]);
    expect(upgraded.meal_items).toEqual([
      expect.objectContaining({ meal_id: "t1", name_snapshot: "fil", amount: "200.0", unit: "g" }),
    ]);
    expect(upgraded.saved_recipes).toEqual([{ id: "r", title: "Fil", meal_id: "t1" }]);
  });
});
