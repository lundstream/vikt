import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Meal, SharedMeal } from "shared";
import type { Db } from "../src/db/index.js";
import { adminLog, foodItems, users } from "../src/db/schema.js";
import { directoryStore, userMediaPrefix } from "../src/lib/media.js";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * Sharing a meal within the installation (Phase 14, D192): who sees what, the
 * copy a reader makes, reports, and what survives whose deletion.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = mkdtempSync(path.join(tmpdir(), "vikt-sharing-"));
const media = directoryStore(mediaDir);
afterAll(() => rmSync(mediaDir, { recursive: true, force: true }));

const ctx = useTestApp({}, { media });

async function named(app: FastifyInstance, user: TestUser, name: string) {
  const response = await app.inject({
    method: "PATCH",
    url: "/api/me/profile",
    headers: auth(user),
    payload: { publicName: name },
  });
  expect(response.statusCode).toBe(200);
}

/** A meal of the author's, one row on a shared food and one on their private one. */
async function authored(app: FastifyInstance, db: Db, author: TestUser) {
  const [shared] = await db
    .insert(foodItems)
    .values({ source: "manual", name: "Kikärtor", kcalPer100: "120", proteinPer100: "7", visibility: "shared" })
    .returning({ id: foodItems.id });
  const [own] = await db
    .insert(foodItems)
    .values({
      source: "label_photo",
      name: "Farmors kryddmix",
      kcalPer100: "300",
      visibility: "private",
      createdBy: author.userId,
    })
    .returning({ id: foodItems.id });
  const meal = (
    await app.inject({
      method: "POST",
      url: "/api/meals",
      headers: auth(author),
      payload: {
        clientUuid: randomUUID(),
        name: "Kikärtsgryta",
        portions: 4,
        items: [
          { foodItemId: shared!.id, nameSnapshot: "Kikärtor", amount: 2, unit: "burkar", grams: 800 },
          { foodItemId: own!.id, nameSnapshot: "Farmors kryddmix", amount: 20, unit: "g", grams: 20 },
        ],
      },
    })
  ).json<Meal>();
  return { meal, sharedFood: shared!.id, privateFood: own!.id };
}

const share = (app: FastifyInstance, user: TestUser, mealId: string, mayShare: unknown = true) =>
  app.inject({ method: "POST", url: `/api/meals/${mealId}/share`, headers: auth(user), payload: { mayShare } });

const sharedList = async (app: FastifyInstance, user: TestUser) =>
  (await app.inject({ method: "GET", url: "/api/meals/shared", headers: auth(user) })).json<{ meals: SharedMeal[] }>()
    .meals;

async function withPhoto(app: FastifyInstance, user: TestUser, mealId: string) {
  const image = readFileSync(path.join(here, "fixtures", "meal-exif.jpg")).toString("base64");
  const response = await app.inject({
    method: "PUT",
    url: `/api/meals/${mealId}/photo`,
    headers: auth(user),
    payload: { image },
  });
  expect(response.statusCode).toBe(200);
}

describe("sharing a meal", () => {
  it("needs a display name, and the sharer's word that it is theirs to share", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const { meal } = await authored(app, db, author);

    const nameless = await share(app, author, meal.id);
    expect(nameless.statusCode).toBe(422);
    expect(nameless.json().error).toBe("no_public_name");

    await named(app, author, "Anna i köket");
    expect((await share(app, author, meal.id, false)).statusCode).toBe(400);

    const shared = await share(app, author, meal.id);
    expect(shared.statusCode).toBe(200);
    expect(shared.json<Meal>().sharedAt).not.toBeNull();
  });

  it("shows readers the meal and the display name, and nothing else about the author", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna i köket");
    const { meal } = await authored(app, db, author);

    expect(await sharedList(app, reader)).toEqual([]);
    await share(app, author, meal.id);

    const [seen] = await sharedList(app, reader);
    expect(seen).toMatchObject({ id: meal.id, name: "Kikärtsgryta", authorName: "Anna i köket", isOwn: false });
    // Priced as the author sees it, the private food included.
    expect(seen!.perPortion.kcal).toBeCloseTo((960 + 60) / 4);
    expect(JSON.stringify(seen)).not.toContain(author.email);
    expect((await sharedList(app, author))[0]!.isOwn).toBe(true);
  });

  it("keeps an unshared meal, and its photo, from everybody else (§3)", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal } = await authored(app, db, author);
    await withPhoto(app, author, meal.id);

    for (const [method, url, payload] of [
      ["GET", `/api/meals/${meal.id}/photo`, undefined],
      ["POST", `/api/meals/shared/${meal.id}/copy`, { clientUuid: randomUUID() }],
      ["POST", `/api/meals/shared/${meal.id}/report`, { reason: "passar inte här" }],
      ["POST", `/api/meals/shared/${meal.id}/log`, { clientUuid: randomUUID(), localDate: localDate(), portions: 1 }],
    ] as const) {
      const response = await app.inject({ method, url, headers: auth(reader), payload });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    await share(app, author, meal.id);
    const photo = await app.inject({ method: "GET", url: `/api/meals/${meal.id}/photo`, headers: auth(reader) });
    expect(photo.statusCode).toBe(200);

    // Shared is readable, never writable by anyone but the author.
    for (const [method, url, payload] of [
      ["PATCH", `/api/meals/${meal.id}`, { name: "Min nu" }],
      ["DELETE", `/api/meals/${meal.id}`, undefined],
      ["POST", `/api/meals/${meal.id}/share`, { mayShare: true }],
      ["DELETE", `/api/meals/${meal.id}/share`, undefined],
      ["PUT", `/api/meals/${meal.id}/photo`, { image: "x".repeat(64) }],
    ] as const) {
      const response = await app.inject({ method, url, headers: auth(reader), ...(payload ? { payload } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("takes an author's meals out of the list when their display name is cleared", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal } = await authored(app, db, author);
    await share(app, author, meal.id);
    await named(app, author, "");
    expect(await sharedList(app, reader)).toEqual([]);
  });
});

describe("copying a shared meal", () => {
  it("makes a snapshot of the reader's own, with the author's private food copied privately", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal, sharedFood, privateFood } = await authored(app, db, author);
    await withPhoto(app, author, meal.id);
    await share(app, author, meal.id);

    const body = { clientUuid: randomUUID() };
    const copy = (
      await app.inject({ method: "POST", url: `/api/meals/shared/${meal.id}/copy`, headers: auth(reader), payload: body })
    ).json<Meal>();
    expect(copy.id).not.toBe(meal.id);
    expect(copy).toMatchObject({ name: "Kikärtsgryta", portions: 4, copiedFromName: "Anna" });
    expect(copy.perPortion.kcal).toBeCloseTo((960 + 60) / 4);
    expect(copy.items[0]!.foodItemId).toBe(sharedFood);
    expect(copy.items[1]!.foodItemId).not.toBe(privateFood);
    const [spice] = await db.select().from(foodItems).where(eq(foodItems.id, copy.items[1]!.foodItemId!));
    expect(spice).toMatchObject({ createdBy: reader.userId, visibility: "private", name: "Farmors kryddmix" });
    expect(await media.list(userMediaPrefix(reader.userId))).toHaveLength(1);

    // Once per reader: saving again finds the same copy.
    const again = (
      await app.inject({ method: "POST", url: `/api/meals/shared/${meal.id}/copy`, headers: auth(reader), payload: { clientUuid: randomUUID() } })
    ).json<Meal>();
    expect(again.id).toBe(copy.id);
  });

  it("logs the reader's copy, which the author's later edits never change", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal, sharedFood } = await authored(app, db, author);
    await share(app, author, meal.id);

    const logged = await app.inject({
      method: "POST",
      url: `/api/meals/shared/${meal.id}/log`,
      headers: auth(reader),
      payload: { clientUuid: randomUUID(), localDate: localDate(), portions: 2 },
    });
    expect(logged.statusCode).toBe(200);
    const { mealId: copyId, entries } = logged.json<{ mealId: string; entries: { grams: number; mealId: string }[] }>();
    expect(copyId).not.toBe(meal.id);
    expect(entries.every((entry) => entry.mealId === copyId)).toBe(true);
    expect(entries.map((entry) => entry.grams).sort((a, b) => a - b)).toEqual([10, 400]);

    await app.inject({
      method: "PATCH",
      url: `/api/meals/${meal.id}`,
      headers: auth(author),
      payload: {
        name: "Något helt annat",
        portions: 1,
        items: [{ foodItemId: sharedFood, nameSnapshot: "Kikärtor", amount: 1, unit: "g", grams: 1 }],
      },
    });

    const copy = (await app.inject({ method: "GET", url: `/api/meals/${copyId}`, headers: auth(reader) })).json<Meal>();
    expect(copy.name).toBe("Kikärtsgryta");
    expect(copy.items).toHaveLength(2);
    const day = (
      await app.inject({ method: "GET", url: `/api/food-entry?from=${localDate()}&to=${localDate()}`, headers: auth(reader) })
    ).json().entries as { grams: number }[];
    expect(day.map((entry) => entry.grams).sort((a, b) => a - b)).toEqual([10, 400]);

    // A second logging uses the same copy.
    const second = await app.inject({
      method: "POST",
      url: `/api/meals/shared/${meal.id}/log`,
      headers: auth(reader),
      payload: { clientUuid: randomUUID(), localDate: localDate(), portions: 1 },
    });
    expect(second.json().mealId).toBe(copyId);
  });

  it("refuses the author's own meal", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal } = await authored(app, db, author);
    await share(app, author, meal.id);
    const response = await app.inject({
      method: "POST",
      url: `/api/meals/shared/${meal.id}/copy`,
      headers: auth(author),
      payload: { clientUuid: randomUUID() },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("reports and unsharing", () => {
  it("lets a reader report and an administrator unshare, and copies stay", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin.userId));
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal } = await authored(app, db, author);
    await share(app, author, meal.id);
    const copy = (
      await app.inject({ method: "POST", url: `/api/meals/shared/${meal.id}/copy`, headers: auth(reader), payload: { clientUuid: randomUUID() } })
    ).json<Meal>();

    const reported = await app.inject({
      method: "POST",
      url: `/api/meals/shared/${meal.id}/report`,
      headers: auth(reader),
      payload: { reason: "Avskrivet ur en kokbok" },
    });
    expect(reported.statusCode).toBe(204);

    // Not an administrator's list to anybody else.
    expect((await app.inject({ method: "GET", url: "/api/admin/meal-reports", headers: auth(reader) })).statusCode).toBe(404);

    const reports = (await app.inject({ method: "GET", url: "/api/admin/meal-reports", headers: auth(admin) })).json()
      .reports as { id: string; mealName: string; reason: string; authorName: string; shared: boolean }[];
    const report = reports.find((entry) => entry.mealName === "Kikärtsgryta")!;
    expect(report).toMatchObject({ reason: "Avskrivet ur en kokbok", authorName: "Anna", shared: true });

    const resolved = await app.inject({
      method: "POST",
      url: `/api/admin/meal-reports/${report.id}/resolve`,
      headers: auth(admin),
      payload: { action: "unshare" },
    });
    expect(resolved.statusCode).toBe(204);

    expect(await sharedList(app, reader)).toEqual([]);
    const stillTheirs = await app.inject({ method: "GET", url: `/api/meals/${copy.id}`, headers: auth(reader) });
    expect(stillTheirs.statusCode).toBe(200);
    const open = (await app.inject({ method: "GET", url: "/api/admin/meal-reports", headers: auth(admin) })).json().reports;
    expect(open.find((entry: { id: string }) => entry.id === report.id)).toBeUndefined();
    const logged = await db.select().from(adminLog).where(eq(adminLog.action, "meal.unshare"));
    expect(logged.some((row) => row.subject === meal.id)).toBe(true);

    // The author still has the meal.
    const authors = await app.inject({ method: "GET", url: `/api/meals/${meal.id}`, headers: auth(author) });
    expect(authors.json<Meal>().sharedAt).toBeNull();
  });
});

describe("deleting the author's account", () => {
  it("removes their shares, and leaves the copies others made theirs", async () => {
    const { app, db } = ctx();
    const author = await createUser(app, db);
    const reader = await createUser(app, db);
    await named(app, author, "Anna");
    const { meal } = await authored(app, db, author);
    await withPhoto(app, author, meal.id);
    await share(app, author, meal.id);
    const copy = (
      await app.inject({ method: "POST", url: `/api/meals/shared/${meal.id}/copy`, headers: auth(reader), payload: { clientUuid: randomUUID() } })
    ).json<Meal>();

    const gone = await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(author),
      payload: { password: author.password },
    });
    expect(gone.statusCode).toBe(200);

    expect(await sharedList(app, reader)).toEqual([]);
    const kept = (await app.inject({ method: "GET", url: `/api/meals/${copy.id}`, headers: auth(reader) })).json<Meal>();
    expect(kept.name).toBe("Kikärtsgryta");
    expect(kept.items.every((item) => item.food !== null)).toBe(true);
    expect(kept.perPortion.kcal).toBeCloseTo((960 + 60) / 4);
    const photo = await app.inject({ method: "GET", url: kept.photoUrl!, headers: auth(reader) });
    expect(photo.statusCode).toBe(200);
    expect(await media.list(userMediaPrefix(author.userId))).toEqual([]);
  });
});
