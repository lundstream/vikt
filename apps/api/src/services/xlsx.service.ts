import ExcelJS from "exceljs";
import { sql } from "drizzle-orm";
import type { DayTableResponse } from "shared";
import { EXPORT_TABLE_NAMES, exportColumnName } from "shared";
import type { Db } from "../db/index.js";
import { excelDate } from "../lib/excel-date.js";
import { getDayTable } from "./day-table.service.js";
import { EXPORTED_TABLES, exportUser } from "./export.service.js";

/**
 * The Excel export (D167): a real .xlsx, not a CSV with the extension changed.
 *
 * **The first sheet is the day table**, the same rows `GET /api/day-table`
 * returns, and after it one sheet per exported table with Swedish headers.
 *
 * **Numbers are numbers and dates are dates.** A cell holding "86,9" as text
 * shows a decimal comma and cannot be summed, sorted or charted, which is the
 * whole reason to want a spreadsheet. So every figure is written as a number
 * with a number format, and Excel draws its decimal separator from the reader's
 * locale: a comma on a Swedish machine. Dates are Excel dates with a date
 * format, never ISO strings.
 *
 * **"Minst" is a number format, not text.** A partial macro is written as its
 * known grams with the format `"minst "0`, so the cell reads "minst 30" and its
 * value is still 30. The sheet says what the table says and still adds up.
 *
 * Built with `exceljs`, pinned to an exact version in `package.json`, and
 * tested by reading the workbook back with the same library
 * (`export-roundtrip.test.ts`). In memory rather than streamed: a personal
 * account is a few thousand rows, and the streaming writer cannot set a column's
 * width after its rows are written.
 */

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const DAY_SHEET_NAME = "Dagar";

type Row = DayTableResponse["rows"][number];
type MacroKey = "protein" | "carbs" | "fat" | "fiber";

export type DayColumn = {
  header: string;
  width: number;
  /** What goes in the cell: a number, a date, text, or nothing. */
  value: (row: Row) => number | Date | string | null;
  /** The cell's number format, which may depend on the row ("minst"). */
  numFmt?: (row: Row) => string;
};

const fixed = (decimals: number) => () => (decimals === 0 ? "0" : `0.${"0".repeat(decimals)}`);

const macroColumn = (key: MacroKey, header: string): DayColumn => ({
  header,
  width: 14,
  value: (row) => row[key].grams,
  // Below D55's gate the known sum is a floor, and says so in the cell. Only a
  // cell with a figure in it: an empty day is not complete either, and a "minst"
  // format on a cell with nothing in it is a claim about nothing.
  numFmt: (row) => (row[key].grams !== null && !row[key].complete ? '"minst "0' : "0"),
});

export const DAY_COLUMNS: DayColumn[] = [
  { header: "Datum", width: 12, value: (row) => excelDate(row.localDate), numFmt: () => "yyyy-mm-dd" },
  { header: "Vikt (kg)", width: 10, value: (row) => row.weightKg, numFmt: fixed(1) },
  { header: "Trend (kg)", width: 11, value: (row) => row.trendKg, numFmt: fixed(1) },
  { header: "Intag (kcal)", width: 12, value: (row) => row.intakeKcal, numFmt: () => "#,##0" },
  {
    header: "Intag med näringsuppgifter",
    width: 26,
    value: (row) => row.intakeCoverage,
    numFmt: () => "0%",
  },
  macroColumn("protein", "Protein (g)"),
  macroColumn("carbs", "Kolhydrater (g)"),
  macroColumn("fat", "Fett (g)"),
  macroColumn("fiber", "Fiber (g)"),
  { header: "Alkohol (standardglas)", width: 22, value: (row) => row.alcoholUnits, numFmt: fixed(1) },
  { header: "Rörelse (minuter)", width: 17, value: (row) => row.activityMinutes, numFmt: fixed(0) },
  { header: "Steg", width: 10, value: (row) => row.steps, numFmt: () => "#,##0" },
  { header: "Sömn (timmar)", width: 14, value: (row) => row.sleepHours, numFmt: fixed(1) },
  { header: "Energi", width: 8, value: (row) => row.energy, numFmt: fixed(0) },
  { header: "Humör", width: 8, value: (row) => row.mood, numFmt: fixed(0) },
  { header: "Midja (cm)", width: 11, value: (row) => row.waistCm, numFmt: fixed(1) },
  { header: "Underhåll (kcal)", width: 16, value: (row) => row.maintenanceKcal, numFmt: () => "#,##0" },
  {
    header: "Underhållets källa",
    width: 18,
    value: (row) =>
      row.maintenanceSource === "adaptive" ? "uppmätt" : row.maintenanceSource === "formula" ? "formel" : null,
  },
  {
    header: "Intag minus underhåll (kcal)",
    width: 27,
    value: (row) => row.intakeMinusMaintenanceKcal,
    numFmt: () => "+#,##0;-#,##0;0",
  },
];

type ColumnType = "number" | "date" | "boolean" | "json" | "text";

function typeOf(dataType: string): ColumnType {
  if (/^(numeric|integer|smallint|bigint|real|double precision)$/.test(dataType)) return "number";
  if (dataType === "date" || dataType.startsWith("timestamp")) return "date";
  if (dataType === "boolean") return "boolean";
  if (dataType === "json" || dataType === "jsonb") return "json";
  return "text";
}

/** One raw value, as the cell its column's database type says it is. */
function cellFor(value: unknown, type: ColumnType): ExcelJS.CellValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "number": {
      const parsed = typeof value === "number" ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : String(value);
    }
    case "date":
      if (value instanceof Date) return value;
      return /^\d{4}-\d{2}-\d{2}$/.test(String(value))
        ? excelDate(String(value))
        : new Date(String(value));
    case "boolean":
      return value === true || value === "t" || value === "true";
    case "json":
      return typeof value === "string" ? value : JSON.stringify(value);
    default:
      return String(value);
  }
}

function header(sheet: ExcelJS.Worksheet, titles: string[], widths: number[]): void {
  sheet.addRow(titles);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
}

export async function buildWorkbook(userId: string, db: Db, asOf: string): Promise<Buffer> {
  const [table, data, columnRows] = await Promise.all([
    getDayTable(userId, db, { to: asOf }),
    exportUser(userId, db),
    db.execute(sql`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`),
  ]);

  const types = new Map<string, ColumnType>();
  for (const row of columnRows as unknown as { table_name: string; column_name: string; data_type: string }[]) {
    types.set(`${row.table_name}.${row.column_name}`, typeOf(row.data_type));
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Vikt";
  workbook.created = new Date();

  /* ---------------------------------------------------- the day table -- */

  const days = workbook.addWorksheet(DAY_SHEET_NAME);
  header(
    days,
    DAY_COLUMNS.map((column) => column.header),
    DAY_COLUMNS.map((column) => column.width),
  );
  for (const row of table.rows) {
    const added = days.addRow(DAY_COLUMNS.map((column) => column.value(row)));
    DAY_COLUMNS.forEach((column, index) => {
      if (column.numFmt) added.getCell(index + 1).numFmt = column.numFmt(row);
    });
  }

  /* ------------------------------------------------- one per entity -- */

  for (const name of EXPORTED_TABLES) {
    const rows = data.tables[name] ?? [];
    const sheet = workbook.addWorksheet(EXPORT_TABLE_NAMES[name] ?? name);

    const columns = [
      ...new Set([
        ...[...types.keys()].filter((key) => key.startsWith(`${name}.`)).map((key) => key.slice(name.length + 1)),
        ...(rows[0] ? Object.keys(rows[0]) : []),
      ]),
    ];
    const columnTypes = columns.map((column) => types.get(`${name}.${column}`) ?? "text");

    header(
      sheet,
      // A column nobody has named yet keeps its database name, and the round
      // trip test refuses exactly that, so it cannot ship unnamed.
      columns.map((column) => exportColumnName(column) ?? column),
      columns.map((column, index) => (columnTypes[index] === "date" ? 18 : Math.max(10, (exportColumnName(column) ?? column).length + 2))),
    );

    for (const row of rows) {
      const added = sheet.addRow(columns.map((column, index) => cellFor(row[column], columnTypes[index]!)));
      columnTypes.forEach((type, index) => {
        if (type !== "date") return;
        const cell = added.getCell(index + 1);
        cell.numFmt = /^\d{4}-\d{2}-\d{2}$/.test(String(row[columns[index]!] ?? ""))
          ? "yyyy-mm-dd"
          : "yyyy-mm-dd hh:mm";
      });
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
