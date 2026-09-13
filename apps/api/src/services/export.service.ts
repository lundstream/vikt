import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";

/**
 * Getting your data out (D96).
 *
 * Two reasons, and the second is the one that made it urgent. The first is
 * portability: with other people about to have accounts here, their data has to
 * be theirs to take, which means reachable from the app rather than only by an
 * admin with a psql prompt. The second is that the Postgres volume is currently
 * the **only** copy of everything.
 *
 * The table list is an explicit allowlist rather than "everything with a
 * user_id", and that is deliberate in both directions. A new data table should
 * not silently join an export nobody reviewed; more importantly a new *secret*
 * table — sessions, reset tokens, API tokens — must not, and a rule that
 * enumerated user-owned tables would have swept all three in.
 */

/**
 * What comes out, in dependency order.
 *
 * The order matters for import: `food_items` must exist before a `food_entry`
 * can point at one, and a `meal_template` before its items. Exported in the
 * same order it has to be read back in, so the import is a loop rather than a
 * topological sort.
 */
export const EXPORTED_TABLES = [
  "profiles",
  "plans",
  "weight_log",
  "measurement_log",
  "daily_log",
  "activity_log",
  "manual_intake",
  "food_entries",
  "food_portions",
  "food_favourites",
  "meal_templates",
  "meal_template_items",
  "milestones",
  "savings_rules",
  "savings_events",
  "savings_offsets",
  "pantry_staples",
  "saved_recipes",
  "weekly_reviews",
  /**
   * The checklist and its ticks (D137). Both, and in this order, because a tick
   * names a habit: the habit rows include archived ones, so a check whose habit
   * was taken off the list still has a word attached to it.
   *
   * A habit name is the user's own words and can describe health, which is
   * exactly why it is in here: what the app holds about somebody is theirs to
   * take (D96, D107).
   */
  "habits",
  "habit_checks",
] as const;

export type ExportedTable = (typeof EXPORTED_TABLES)[number];

/**
 * Tables deliberately left out, named so the omission is a decision.
 *
 * `sessions`, `password_resets` and `api_tokens` are credentials: exporting
 * them would put working keys into a file people email themselves. `llm_jobs`
 * is transient work. `photos` rows are excluded because the files they point at
 * are not in the database (D10) and a row without its file is a broken
 * reference pretending to be data. `food_items` is a **shared cache** rather
 * than user data, and is handled separately below.
 */
export const EXCLUDED_TABLES = [
  "sessions",
  "password_resets",
  "api_tokens",
  "llm_jobs",
  "photos",
  "group_members",
] as const;

/**
 * `meal_template_items` hangs off a template rather than off a user, so it is
 * scoped through its parent. Everything else has `user_id` directly.
 */
const SCOPE: Partial<Record<ExportedTable, string>> = {
  meal_template_items: `template_id in (select id from meal_templates where user_id = $1)`,
};

async function rowsFor(db: Db, table: ExportedTable, userId: string) {
  const predicate = SCOPE[table] ?? "user_id = $1";
  const result = await db.execute(
    sql.raw(`select * from ${table} where ${predicate.replace("$1", `'${userId}'`)}`),
  );
  return result as unknown as Record<string, unknown>[];
}

export type UserExport = {
  /** So a future import can refuse a file it does not understand. */
  format: "vikt-export";
  version: 1;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
  /**
   * The food items this user's rows point at.
   *
   * `food_items` is a shared cache, not user data, so it is not exported as a
   * table — but an export whose food entries referenced ids that do not exist
   * in the target database would import as rows with no name and no nutrition.
   * Only the ones actually referenced travel, which keeps a personal export
   * from carrying a copy of the whole Livsmedelsverket database.
   */
  foodItems: Record<string, unknown>[];
};

export async function exportUser(userId: string, db: Db): Promise<UserExport> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of EXPORTED_TABLES) {
    tables[table] = await rowsFor(db, table, userId);
  }

  const referenced = await db.execute(
    sql.raw(`
      select distinct fi.* from food_items fi
      where fi.id in (
        select food_item_id from food_entries where user_id = '${userId}' and food_item_id is not null
        union
        select food_item_id from food_portions where user_id = '${userId}'
        union
        select food_item_id from food_favourites where user_id = '${userId}'
        union
        select food_item_id from pantry_staples where user_id = '${userId}' and food_item_id is not null
        union
        select mti.food_item_id from meal_template_items mti
          join meal_templates mt on mt.id = mti.template_id
          where mt.user_id = '${userId}' and mti.food_item_id is not null
      )`),
  );

  return {
    format: "vikt-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    tables,
    foodItems: referenced as unknown as Record<string, unknown>[],
  };
}

/* -------------------------------------------------------------------- CSV */

/**
 * Semicolon-delimited, UTF-8 with a byte-order mark (D96).
 *
 * Both choices are about one thing: the file opening correctly when someone
 * double-clicks it in Excel on a Swedish machine.
 *
 * **Semicolon**, because Excel splits on the system list separator, and in a
 * Swedish locale that is `;`. A comma-delimited file opens as one column per
 * row — and worse, a Swedish decimal comma inside a comma-delimited file splits
 * numbers in half.
 *
 * **A BOM**, because Excel assumes the legacy code page for a file without one
 * and renders å, ä and ö as mojibake. It costs three bytes and every other tool
 * ignores it.
 *
 * Values keep the database's own representation rather than going through the
 * sv-SE display formatter: a CSV is data, and a number with a decimal comma and
 * a space as a thousands separator is a string. The formatter's job is screens.
 */
export const CSV_DELIMITER = ";";
export const CSV_BOM = "﻿";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // Quote when the cell could otherwise break the row apart.
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One table as CSV, yielded a row at a time.
 *
 * A generator rather than a string, because an export is unbounded: a few years
 * of food entries is tens of thousands of rows, and building the whole file in
 * memory to hand to the response is how a modest server runs out of it. The
 * route pipes this straight into the reply.
 */
export async function* csvFor(
  userId: string,
  db: Db,
  table: ExportedTable,
): AsyncGenerator<string> {
  const rows = await rowsFor(db, table, userId);
  if (rows.length === 0) {
    yield CSV_BOM;
    return;
  }

  const columns = Object.keys(rows[0]!);
  yield CSV_BOM + columns.join(CSV_DELIMITER) + "\r\n";

  for (const row of rows) {
    yield columns.map((column) => csvCell(row[column])).join(CSV_DELIMITER) + "\r\n";
  }
}
