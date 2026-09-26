/**
 * Reading exports written by older versions (D96, D186). Pure: a file in, a
 * file out, no database and no user, which is why it lives here rather than in
 * the service that calls it.
 */

export type Rows = Record<string, unknown>[];

/**
 * An export written before 1.3 carries meal templates, and reads back as meals.
 *
 * The same mapping as `0032_meals.sql`, applied to the file instead of the
 * database, because an export is somebody's copy of their data and it has to
 * stay readable after the app it came from moved on (D96, D186). Each template
 * becomes a meal of one portion under its own id, each row the same grams with
 * the unit "g", and a recipe's `template_id` becomes its `meal_id`.
 */
export function upgradeLegacyTables(tables: Record<string, Rows>): Record<string, Rows> {
  const templates = tables.meal_templates;
  if (templates === undefined || tables.meals !== undefined) return tables;

  const { meal_templates: _templates, meal_template_items: items = [], ...rest } = tables;
  const at = (row: Record<string, unknown>, key: string) => row[key] ?? null;

  return {
    ...rest,
    meals: templates.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      client_uuid: row.id,
      name: row.name,
      portions: 1,
      default_meal_slot: at(row, "default_meal_slot"),
      logged_count: row.use_count ?? 0,
      last_logged_at: at(row, "last_used_at"),
      created_at: row.created_at,
      updated_at: row.last_used_at ?? row.created_at,
    })),
    meal_items: items.map((row) => ({
      id: row.id,
      meal_id: row.template_id,
      food_item_id: at(row, "food_item_id"),
      name_snapshot:
        (typeof row.name_snapshot === "string" && row.name_snapshot !== ""
          ? row.name_snapshot
          : row.freetext) ?? "",
      amount: row.grams,
      unit: "g",
      grams: row.grams,
      position: row.position ?? 0,
    })),
    saved_recipes: (rest.saved_recipes ?? []).map(({ template_id, ...row }) => ({
      ...row,
      meal_id: row.meal_id ?? template_id ?? null,
    })),
  };
}
