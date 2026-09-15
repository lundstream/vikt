import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";
import { CSV_BOM, CSV_DELIMITER, EXCLUDED_TABLES, EXPORTED_TABLES } from "../src/services/export.service.js";
import ExcelJS from "exceljs";
import { EXPORT_TABLE_NAMES } from "shared";
import { DAY_COLUMNS, DAY_SHEET_NAME, XLSX_CONTENT_TYPE } from "../src/services/xlsx.service.js";
import { excelDate } from "../src/lib/excel-date.js";

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

/**
 * The Excel workbook (D167), held to the same standard as the JSON and the CSV:
 * it opens, and what is in it is what the app has.
 */
describe("the Excel workbook", () => {
  const ctx = useTestApp();

  async function workbookFor(
    app: Awaited<ReturnType<ReturnType<typeof useTestApp>>>["app"],
    user: Awaited<ReturnType<typeof createUser>>,
  ) {
    const response = await app.inject({
      method: "GET",
      url: `/api/export/xlsx?asOf=${localDate()}`,
      headers: auth(user),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(XLSX_CONTENT_TYPE);

    // A real .xlsx is a zip, and a renamed CSV is not.
    const bytes = response.rawPayload;
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");

    const workbook = new ExcelJS.Workbook();
    // exceljs types `load` against an older Buffer declaration than Node 22's.
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    return workbook;
  }

  it("opens, with the day table first and one sheet per exported table", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(app, user);

    const workbook = await workbookFor(app, user);
    const names = workbook.worksheets.map((sheet) => sheet.name);

    expect(names[0]).toBe(DAY_SHEET_NAME);
    expect(names.slice(1)).toEqual(EXPORTED_TABLES.map((table) => EXPORT_TABLE_NAMES[table]));
  });

  /** The claim the brief makes, asserted: the first sheet's numbers are the table's. */
  it("has the day table's numbers on its first sheet, as numbers and dates", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(app, user);

    const workbook = await workbookFor(app, user);
    const table = (
      await app.inject({ method: "GET", url: `/api/day-table?to=${localDate()}`, headers: auth(user) })
    ).json<{ rows: Parameters<(typeof DAY_COLUMNS)[number]["value"]>[0][] }>();

    const sheet = workbook.worksheets[0]!;
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(DAY_COLUMNS.map((column) => column.header));
    expect(sheet.rowCount - 1).toBe(table.rows.length);

    table.rows.forEach((row, index) => {
      const cells = sheet.getRow(index + 2);
      DAY_COLUMNS.forEach((column, columnIndex) => {
        const expected = column.value(row);
        const actual = cells.getCell(columnIndex + 1).value;
        if (expected === null) {
          expect(actual ?? null, `${row.localDate} ${column.header}`).toBeNull();
        } else if (expected instanceof Date) {
          expect(actual, `${row.localDate} ${column.header}`).toBeInstanceOf(Date);
          expect((actual as Date).getTime()).toBe(expected.getTime());
        } else if (typeof expected === "number") {
          expect(typeof actual, `${row.localDate} ${column.header}`).toBe("number");
          expect(actual as number).toBeCloseTo(expected, 9);
        } else {
          expect(actual).toBe(expected);
        }
      });
    });

    // The first row is the first day, as a date and not as text.
    expect(sheet.getRow(2).getCell(1).value).toEqual(excelDate(table.rows[0]!.localDate));
  });

  /**
   * A day of food entries only, and deliberately not `seed()`'s: manual intake
   * wins over food entries for its day, in `resolveMacros` exactly as in
   * `resolveIntake`, so a partial food day on a manual day is not a partial day
   * at all. The first draft of this test made that mistake and found the protein
   * cell empty, which was the app being right.
   */
  it("writes a partial macro as its known number, formatted to say minst", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const payload of [
      // Carries protein and nothing else, 300 of the day's 800 kcal.
      { freetext: "Kvarg", grams: 300, kcal: 300, proteinG: 30 },
      // Carries no macros at all.
      { freetext: "Middag", grams: 500, kcal: 500 },
    ]) {
      const logged = await app.inject({
        method: "POST",
        url: "/api/food-entry",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(),
          confidence: 1,
          confirmed: true,
          ...payload,
        },
      });
      expect(logged.statusCode, logged.body).toBeLessThan(300);
    }

    const workbook = await workbookFor(app, user);
    const sheet = workbook.worksheets[0]!;
    const column = (header: string) => DAY_COLUMNS.findIndex((candidate) => candidate.header === header) + 1;
    const today = sheet.getRow(sheet.rowCount);

    // 30 g known from 300 of 800 kcal: under D55's gate, so a floor.
    expect(today.getCell(column("Protein (g)")).value).toBe(30);
    expect(today.getCell(column("Protein (g)")).numFmt).toBe('"minst "0');
    // Nothing logged carries carbohydrate: no figure, not a zero, and no "minst"
    // format on a cell that has nothing in it.
    expect(today.getCell(column("Kolhydrater (g)")).value ?? null).toBeNull();
    expect(today.getCell(column("Kolhydrater (g)")).numFmt).not.toBe('"minst "0');
    expect(today.getCell(column("Intag med näringsuppgifter")).value).toBeCloseTo(300 / 800, 9);
  });

  /**
   * The round trip, for the raw sheets: every row the JSON export carries is in
   * its sheet, every header is Swedish, and a date column holds dates.
   */
  it("carries every exported row under a Swedish header, numbers as numbers", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await seed(app, user);

    const workbook = await workbookFor(app, user);
    const file = (
      await app.inject({ method: "GET", url: "/api/export/json", headers: auth(user) })
    ).json<{ tables: Record<string, Record<string, unknown>[]> }>();

    for (const table of EXPORTED_TABLES) {
      const sheet = workbook.getWorksheet(EXPORT_TABLE_NAMES[table]!)!;
      const headers = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
      const rawColumns = file.tables[table]![0] ? Object.keys(file.tables[table]![0]!) : [];

      // A column that reached the workbook without a Swedish name keeps its
      // database name, and that is what this refuses.
      for (const column of rawColumns) {
        expect(headers, `${table}.${column} has no Swedish header`).not.toContain(column);
      }
      expect(sheet.rowCount - 1, table).toBe(file.tables[table]!.length);
    }

    const weights = workbook.getWorksheet(EXPORT_TABLE_NAMES.weight_log!)!;
    const headers = (weights.getRow(1).values as unknown[]).slice(1) as string[];
    const weightCell = weights.getRow(2).getCell(headers.indexOf("Vikt (kg)") + 1).value;
    const dateCell = weights.getRow(2).getCell(headers.indexOf("Datum") + 1).value;

    expect(typeof weightCell).toBe("number");
    expect(file.tables.weight_log!.map((row) => Number(row.weight_kg))).toContain(weightCell);
    expect(dateCell).toBeInstanceOf(Date);
  });

  it("keeps another account's rows out", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    await seed(app, mine);

    const workbook = await workbookFor(app, theirs);
    expect(workbook.getWorksheet(EXPORT_TABLE_NAMES.weight_log!)!.rowCount).toBe(1);
  });
});
