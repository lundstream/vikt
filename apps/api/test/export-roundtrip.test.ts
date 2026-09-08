import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";
import { CSV_BOM, CSV_DELIMITER, EXCLUDED_TABLES, EXPORTED_TABLES } from "../src/services/export.service.js";

/**
 * Export and import (D96).
 *
 * The round trip is the point, and it is worth more than the import feature it
 * uses. What it proves is that the **export is complete**: if a file can be
 * read into an empty account and every derived number comes out identical, then
 * nothing feeding those numbers was left out of it.
 *
 * The derived numbers are the right thing to compare because they are downstream
 * of nearly everything — the trend needs the weight log, maintenance needs the
 * trend and the intake, the target needs the plan, the macros need the profile.
 * A missing table shows up as a number that moved.
 */

/** A history with enough in it that the derived figures are not trivial. */
async function seed(
  app: Awaited<ReturnType<ReturnType<typeof useTestApp>>>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
) {
  for (let day = 40; day >= 0; day -= 1) {
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-day),
        weightKg: 92 - (40 - day) * 0.05,
      },
    });

    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-day),
        kcal: 2000 + (day % 5) * 50,
      },
    });
  }

  await app.inject({
    method: "POST",
    url: "/api/plan",
    headers: auth(user),
    payload: { goalWeightKg: 84, targetIntakeKcal: 1900 },
  });
}

const insightsFor = async (
  app: Awaited<ReturnType<ReturnType<typeof useTestApp>>>["app"],
  user: Awaited<ReturnType<typeof createUser>>,
) => (await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })).json();

describe("a round trip through the export", () => {
  const ctx = useTestApp();

  /**
   * The test the whole feature exists for.
   *
   * Not "the file has rows in it" — a file can have rows in it and still be
   * missing the plan, and the only way that shows up is as a maintenance figure
   * that differs after the restore.
   */
  it("produces identical derived numbers in a fresh account", async () => {
    const { app, db } = ctx();
    const source = await createUser(app, db);
    await seed(app, source);

    const before = await insightsFor(app, source);
    expect(before.maintenance.tdee).not.toBeNull();

    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(source) })
    ).json();

    const target = await createUser(app, db);
    const imported = await app.inject({
      method: "POST",
      url: "/api/import/json",
      headers: auth(target),
      payload: file,
    });
    expect(imported.statusCode).toBe(200);

    const after = await insightsFor(app, target);

    // Every derived figure, not a sample of them.
    expect(after.maintenance.tdee).toBeCloseTo(before.maintenance.tdee, 6);
    expect(after.maintenance.source).toBe(before.maintenance.source);
    expect(after.maintenance.coverage).toBeCloseTo(before.maintenance.coverage, 6);
    expect(after.trendWeightKg).toBeCloseTo(before.trendWeightKg, 6);
    expect(after.targetIntakeKcal).toBe(before.targetIntakeKcal);
    expect(after.todayIntakeKcal).toBe(before.todayIntakeKcal);
  });

  it("refuses to import into an account that already has data", async () => {
    const { app, db } = ctx();
    const source = await createUser(app, db);
    await seed(app, source);

    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(source) })
    ).json();

    // Back into the account it came from, which is by definition not empty.
    const response = await app.inject({
      method: "POST",
      url: "/api/import/json",
      headers: auth(source),
      payload: file,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("account_not_empty");
  });

  it("refuses a file that is not an export", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/import/json",
      headers: auth(user),
      payload: { some: "other file" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("not_an_export");
  });
});

describe("what the export contains", () => {
  const ctx = useTestApp();

  it("carries one user's rows and nobody else's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(mine),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 81 },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(theirs),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 99 },
    });

    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(mine) })
    ).json();

    expect(file.tables.weight_log).toHaveLength(1);
    expect(Number(file.tables.weight_log[0].weight_kg)).toBe(81);
  });

  /**
   * The exclusions are a decision, not an accident, so they are pinned. A
   * future table added to the export list has to pass this: no credential ever
   * leaves in a file someone emails themselves.
   */
  it("carries no credentials", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(user) })
    ).json();

    for (const excluded of EXCLUDED_TABLES) {
      expect(Object.keys(file.tables)).not.toContain(excluded);
    }
    // And nothing that looks like one leaked into a row.
    const text = JSON.stringify(file);
    expect(text).not.toContain("password_hash");
    expect(text).not.toContain("token_hash");
  });

  /**
   * A food entry points at a shared cache row. Without it, an import produces
   * entries with no name and no nutrition.
   */
  it("carries the food items its rows point at, and no others", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const item = (
      await app.inject({
        method: "POST",
        url: "/api/food/manual",
        headers: auth(user),
        payload: { name: "Havregryn", kcalPer100: 357 },
      })
    ).json();

    // A second item nothing references.
    await app.inject({
      method: "POST",
      url: "/api/food/manual",
      headers: auth(user),
      payload: { name: "Nothing points here", kcalPer100: 100 },
    });

    await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        foodItemId: item.id,
        grams: 60,
        confidence: 1,
        confirmed: true,
      },
    });

    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(user) })
    ).json();

    const ids = file.foodItems.map((row: { id: string }) => row.id);
    expect(ids).toContain(item.id);
    // A personal export does not carry a copy of the whole food database.
    expect(file.foodItems).toHaveLength(1);
  });
});

describe("the CSV", () => {
  const ctx = useTestApp();

  /**
   * Both choices exist so the file opens correctly on a double-click in Excel
   * with a Swedish locale (D96): `;` because that is the list separator there,
   * and a BOM because Excel otherwise assumes a legacy code page and renders
   * å, ä and ö as mojibake.
   */
  it("is semicolon-delimited UTF-8 with a byte-order mark", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 81.5 },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/export/csv/weight_log",
      headers: auth(user),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("charset=utf-8");

    const body = response.body;
    expect(body.startsWith(CSV_BOM)).toBe(true);
    const header = body.slice(CSV_BOM.length).split("\r\n")[0]!;
    expect(header.split(CSV_DELIMITER).length).toBeGreaterThan(3);
    expect(header).toContain("weight_kg");
  });

  it("offers every table the export knows about", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({ method: "GET", url: "/api/export/tables", headers: auth(user) })
    ).json();

    expect(body.tables).toEqual([...EXPORTED_TABLES]);
  });

  it("refuses a table that is not in the export", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: "/api/export/csv/sessions",
      headers: auth(user),
    });

    expect(response.statusCode).toBe(400);
  });
});
