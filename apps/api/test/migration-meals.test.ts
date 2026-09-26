import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { testDatabaseUrl } from "./database.js";

/**
 * 0032 moves every meal template into `meals` and drops the old tables (D186).
 *
 * The one migration in this repository that is not additive, so it is the one
 * that gets a test of its own: a database migrated to 0031, holding templates
 * the way 1.2 wrote them, then 0032, then a read of what came out. "Without
 * loss" is checked field by field, including the recipe that pointed at a
 * template and the freetext row from before `name_snapshot` existed.
 */

const DRIZZLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

type Journal = { entries: { idx: number; tag: string }[] };

/** A copy of the migrations folder that stops before `tag`. */
function foldersUntil(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vikt-migrations-"));
  cpSync(DRIZZLE, dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const at = journal.entries.findIndex((entry) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const name = `vikt_migration_${process.pid}_${Date.now()}`;
let url: string;
let sql: postgres.Sql;
let before: string;

beforeAll(async () => {
  const admin = new URL(testDatabaseUrl());
  admin.pathname = "/postgres";
  const adminClient = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await adminClient.unsafe(`create database "${name}"`);
  await adminClient.end();

  const target = new URL(testDatabaseUrl());
  target.pathname = `/${name}`;
  url = target.toString();
  sql = postgres(url, { max: 1, onnotice: () => {} });

  before = foldersUntil("0032_meals");
  await migrate(drizzle(sql), { migrationsFolder: before });
});

afterAll(async () => {
  await sql?.end();
  rmSync(before, { recursive: true, force: true });
  const admin = new URL(testDatabaseUrl());
  admin.pathname = "/postgres";
  const adminClient = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  await adminClient.unsafe(`drop database if exists "${name}"`);
  await adminClient.end();
});

describe("0032_meals", () => {
  it("turns every template into a meal of one portion, and loses nothing", async () => {
    const [user] = await sql`
      insert into users (email, password_hash, display_name) values ('meals@example.test', 'x', 'M') returning id`;
    const [food] = await sql`
      insert into food_items (source, name, kcal_per_100, visibility)
      values ('manual', 'Havregryn', 370, 'shared') returning id`;
    const usedAt = new Date("2026-09-20T07:30:00Z");
    const [breakfast] = await sql`
      insert into meal_templates (user_id, name, default_meal_slot, use_count, last_used_at, created_at)
      values (${user!.id}, 'Frukost', 'breakfast', 7, ${usedAt.toISOString()}, '2026-08-01T06:00:00Z')
      returning id`;
    const [plain] = await sql`
      insert into meal_templates (user_id, name) values (${user!.id}, 'Mellanmål') returning id`;
    await sql`
      insert into meal_template_items (template_id, food_item_id, name_snapshot, grams, position)
      values (${breakfast!.id}, ${food!.id}, 'Havregryn', 60, 0)`;
    // A row from before 0002: no name snapshot, only the words typed.
    await sql`
      insert into meal_template_items (template_id, food_item_id, name_snapshot, freetext, grams, position)
      values (${breakfast!.id}, null, '', 'mjölk från kossan', 250.5, 1)`;
    await sql`
      insert into meal_template_items (template_id, food_item_id, name_snapshot, grams, position)
      values (${plain!.id}, ${food!.id}, 'Havregryn', 30, 0)`;
    const [recipe] = await sql`
      insert into saved_recipes (user_id, title, steps, items, template_id)
      values (${user!.id}, 'Gröt', '["koka"]', '[]', ${breakfast!.id}) returning id`;

    await migrate(drizzle(sql), { migrationsFolder: DRIZZLE });

    const meals = await sql`
      select id, user_id, client_uuid, name, portions::text, default_meal_slot, logged_count,
             last_logged_at, created_at, updated_at
      from meals order by name`;
    expect(meals).toHaveLength(2);
    const [frukost, mellan] = [meals[0]!, meals[1]!];

    expect(frukost.id).toBe(breakfast!.id);
    expect(frukost.client_uuid).toBe(breakfast!.id);
    expect(frukost.user_id).toBe(user!.id);
    expect(frukost.portions).toBe("1.00");
    expect(frukost.default_meal_slot).toBe("breakfast");
    expect(frukost.logged_count).toBe(7);
    expect(new Date(frukost.last_logged_at).toISOString()).toBe(usedAt.toISOString());
    expect(new Date(frukost.created_at).toISOString()).toBe("2026-08-01T06:00:00.000Z");
    expect(mellan.logged_count).toBe(0);
    expect(mellan.last_logged_at).toBeNull();

    const items = await sql`
      select meal_id, food_item_id, name_snapshot, amount::text, unit, grams::text, position
      from meal_items order by meal_id, position`;
    const ofBreakfast = items.filter((item) => item.meal_id === breakfast!.id);
    expect(ofBreakfast).toEqual([
      {
        meal_id: breakfast!.id,
        food_item_id: food!.id,
        name_snapshot: "Havregryn",
        amount: "60.00",
        unit: "g",
        grams: "60.0",
        position: 0,
      },
      {
        meal_id: breakfast!.id,
        food_item_id: null,
        name_snapshot: "mjölk från kossan",
        amount: "250.50",
        unit: "g",
        grams: "250.5",
        position: 1,
      },
    ]);
    expect(items.filter((item) => item.meal_id === plain!.id)).toHaveLength(1);

    const [kept] = await sql`select meal_id from saved_recipes where id = ${recipe!.id}`;
    expect(kept!.meal_id).toBe(breakfast!.id);

    const old = await sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('meal_templates', 'meal_template_items')`;
    expect(old).toHaveLength(0);

    // The recipe's reference now follows the meal, as the template's did.
    await sql`delete from meals where id = ${breakfast!.id}`;
    const [after] = await sql`select meal_id from saved_recipes where id = ${recipe!.id}`;
    expect(after!.meal_id).toBeNull();
  });
});
