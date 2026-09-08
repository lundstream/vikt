import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { EXPORTED_TABLES, type UserExport } from "./export.service.js";

/**
 * Reading an export back (D96).
 *
 * The import is worth less than the test that uses it. What that test proves is
 * that the **export is complete**: if a file can be read into an empty account
 * and every derived number in `calc/` comes out identical, then nothing that
 * feeds those numbers was left out. Without it, "we have an export" means
 * "we have a file", and the difference is only discovered on the day it matters.
 *
 * Deliberately narrow. It imports into an **empty** account and refuses
 * otherwise: merging two histories raises questions — which weight wins for a
 * day both files have, what happens to two plans — that have real answers and
 * none of them are needed to prove the export complete.
 */

export type ImportOutcome =
  | { ok: true; rows: number }
  | { ok: false; reason: "not_an_export" | "wrong_version" | "account_not_empty" };

/** Columns that must be re-pointed at the receiving account. */
const OWNED = new Set<string>(
  EXPORTED_TABLES.filter((table) => table !== "meal_template_items"),
);

/**
 * Whether this account has anything that would collide.
 *
 * Profiles are excluded from the check: every account has one by construction,
 * and the import updates it rather than inserting a second.
 */
async function isEmpty(db: Db, userId: string): Promise<boolean> {
  for (const table of EXPORTED_TABLES) {
    if (table === "profiles") continue;
    if (!OWNED.has(table)) continue;
    const result = await db.execute(
      sql.raw(`select 1 from ${table} where user_id = '${userId}' limit 1`),
    );
    if ((result as unknown as unknown[]).length > 0) return false;
  }
  return true;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Foreign keys between exported tables, and what they point at.
 *
 * Every imported row gets a **fresh primary key**, which is what makes an
 * import work at all: the export carries the source's ids, and reading it back
 * into a database that still holds the source — importing your own export into
 * a second account on the same server, which is exactly what portability means
 * — collides on every primary key. `on conflict do nothing` then silently
 * imported nothing, and the round-trip test caught it as a maintenance figure
 * that came back null.
 *
 * `food_item_id` is deliberately **not** here. It points at the shared cache,
 * where the same item is the same item; remapping it would fork the food
 * database one import at a time.
 */
const REMAPPED_KEYS: Partial<Record<string, { column: string; from: string }[]>> = {
  meal_template_items: [{ column: "template_id", from: "meal_templates" }],
  saved_recipes: [{ column: "template_id", from: "meal_templates" }],
  savings_events: [{ column: "milestone_id", from: "milestones" }],
  savings_offsets: [{ column: "rule_id", from: "savings_rules" }],
};

export async function importUser(
  userId: string,
  db: Db,
  data: unknown,
): Promise<ImportOutcome> {
  const file = data as Partial<UserExport>;
  if (file?.format !== "vikt-export") return { ok: false, reason: "not_an_export" };
  if (file.version !== 1) return { ok: false, reason: "wrong_version" };
  if (!(await isEmpty(db, userId))) return { ok: false, reason: "account_not_empty" };

  let rows = 0;
  /** Old id to new, per table, so the four foreign keys above can follow. */
  const remap = new Map<string, Map<string, string>>();

  /**
   * The shared food cache first, and only where the row is missing.
   *
   * `on conflict do nothing` is right *here* and nowhere else: a food item that
   * already exists in this database is the same item, and its id is the thing
   * the importing rows point at. Overwriting it with a copy from someone else's
   * export would let an import edit shared data.
   */
  for (const item of file.foodItems ?? []) {
    const columns = Object.keys(item);
    await db.execute(
      sql.raw(
        `insert into food_items (${columns.join(",")}) values (${columns
          .map((column) => literal(item[column]))
          .join(",")}) on conflict do nothing`,
      ),
    );
  }

  for (const table of EXPORTED_TABLES) {
    for (const row of file.tables?.[table] ?? []) {
      const values: Record<string, unknown> = { ...row };

      // Re-point at the receiving account. The exported id belonged to another.
      if (OWNED.has(table)) values.user_id = userId;

      /**
       * A fresh key, and a note of what it replaced.
       *
       * `profiles` is keyed on `user_id` and has no `id`, so it is untouched
       * by this and updates in place below.
       */
      const oldId = typeof values.id === "string" ? values.id : null;
      if (oldId !== null) {
        const fresh = randomUUID();
        values.id = fresh;
        const forTable = remap.get(table) ?? new Map<string, string>();
        forTable.set(oldId, fresh);
        remap.set(table, forTable);
      }

      // Follow the foreign keys to whatever their targets became.
      for (const key of REMAPPED_KEYS[table] ?? []) {
        const current = values[key.column];
        if (typeof current === "string") {
          values[key.column] = remap.get(key.from)?.get(current) ?? null;
        }
      }

      const columns = Object.keys(values);
      const statement =
        table === "profiles"
          ? // Every account already has one, so this is an update in insert's
            // clothing: the columns the export carries win, the key does not move.
            `insert into profiles (${columns.join(",")}) values (${columns
              .map((c) => literal(values[c]))
              .join(",")}) on conflict (user_id) do update set ${columns
              .filter((c) => c !== "user_id")
              .map((c) => `${c} = excluded.${c}`)
              .join(",")}`
          : `insert into ${table} (${columns.join(",")}) values (${columns
              .map((c) => literal(values[c]))
              .join(",")})`;

      await db.execute(sql.raw(statement));
      rows += 1;
    }
  }

  return { ok: true, rows };
}
