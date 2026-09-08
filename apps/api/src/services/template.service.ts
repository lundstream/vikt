import type { ApplyTemplate, CreateTemplate, FoodEntry, MealTemplate } from "shared";
import { toNumber, toNumeric } from "shared";
import type { Db } from "../db/index.js";
import {
  deleteTemplate as deleteTemplateRow,
  findTemplate,
  insertTemplate,
  listTemplateItems,
  listTemplates,
  renameTemplate,
  replaceTemplateItems,
  touchTemplate,
  type MealTemplateRow,
} from "../repositories/food.repo.js";
import { saveFoodEntry } from "./food.service.js";
import { badRequest, notFound } from "../lib/errors.js";

/**
 * Meal templates: "last Tuesday's breakfast, again".
 *
 * Each item keeps a `nameSnapshot` taken when it was added, so deleting the
 * food it points at leaves a readable line rather than grams of nothing (D17).
 */

async function toTemplate(
  userId: string,
  db: Db,
  row: MealTemplateRow,
): Promise<MealTemplate> {
  const items = await listTemplateItems(userId, db, row.id);
  return {
    id: row.id,
    name: row.name,
    defaultMealSlot: row.defaultMealSlot,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    items: items.map((item) => ({
      foodItemId: item.foodItemId,
      nameSnapshot: item.nameSnapshot,
      freetext: item.freetext,
      grams: toNumber(item.grams),
      position: item.position,
    })),
  };
}

export async function getTemplates(userId: string, db: Db): Promise<MealTemplate[]> {
  const rows = await listTemplates(userId, db);
  return Promise.all(rows.map((row) => toTemplate(userId, db, row)));
}

export async function getTemplate(
  userId: string,
  db: Db,
  templateId: string,
): Promise<MealTemplate> {
  const row = await findTemplate(userId, db, templateId);
  if (!row) throw notFound("Det finns ingen sådan måltid.");
  return toTemplate(userId, db, row);
}

export async function createTemplate(
  userId: string,
  db: Db,
  input: CreateTemplate,
): Promise<MealTemplate> {
  const row = await insertTemplate(userId, db, {
    name: input.name,
    defaultMealSlot: input.defaultMealSlot ?? null,
  });

  await replaceTemplateItems(
    userId,
    db,
    row.id,
    input.items.map((item, position) => ({
      foodItemId: item.foodItemId ?? null,
      // Never empty: a template item without a name is the D17 failure.
      nameSnapshot: item.nameSnapshot,
      freetext: item.freetext ?? null,
      grams: toNumeric(item.grams, 1),
      position,
    })),
  );

  return toTemplate(userId, db, row);
}

export async function editTemplate(
  userId: string,
  db: Db,
  templateId: string,
  input: Partial<CreateTemplate>,
): Promise<MealTemplate> {
  const existing = await findTemplate(userId, db, templateId);
  if (!existing) throw notFound("Det finns ingen sådan måltid.");

  if (input.name !== undefined) {
    await renameTemplate(userId, db, templateId, input.name);
  }

  if (input.items !== undefined) {
    await replaceTemplateItems(
      userId,
      db,
      templateId,
      input.items.map((item, position) => ({
        foodItemId: item.foodItemId ?? null,
        nameSnapshot: item.nameSnapshot,
        freetext: item.freetext ?? null,
        grams: toNumeric(item.grams, 1),
        position,
      })),
    );
  }

  return getTemplate(userId, db, templateId);
}

export async function removeTemplate(
  userId: string,
  db: Db,
  templateId: string,
): Promise<void> {
  if (!(await deleteTemplateRow(userId, db, templateId))) {
    throw notFound("Den här måltiden finns inte.");
  }
}

/**
 * Applies a template: one food entry per item, on the given day.
 *
 * The caller supplies one `clientUuid` per item so replaying the whole
 * application is idempotent the same way a single entry is (§3). Getting that
 * wrong would turn a flaky connection into a doubled breakfast.
 */
export async function applyTemplate(
  userId: string,
  db: Db,
  templateId: string,
  input: ApplyTemplate,
): Promise<FoodEntry[]> {
  const template = await findTemplate(userId, db, templateId);
  if (!template) throw notFound("Det finns ingen sådan måltid.");

  const items = await listTemplateItems(userId, db, templateId);
  if (items.length === 0) throw badRequest("empty_template", "Måltiden är tom.");

  if (input.clientUuids.length !== items.length) {
    throw badRequest(
      "uuid_count",
      `Måltiden har ${items.length} rader men ${input.clientUuids.length} id:n skickades.`,
    );
  }

  const entries: FoodEntry[] = [];
  for (const [index, item] of items.entries()) {
    entries.push(
      await saveFoodEntry(userId, db, {
        clientUuid: input.clientUuids[index]!,
        localDate: input.localDate,
        mealSlot: input.mealSlot ?? template.defaultMealSlot ?? "snack",
        foodItemId: item.foodItemId,
        freetext: item.foodItemId ? null : (item.freetext ?? item.nameSnapshot),
        grams: toNumber(item.grams),
        // A freetext template row has no item to compute from, so it carries no
        // energy; those are rejected rather than logged as zero.
        kcal: null,
        confidence: 1,
        confirmed: true,
      }),
    );
  }

  await touchTemplate(userId, db, templateId);
  return entries;
}
