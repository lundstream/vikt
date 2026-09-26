import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { foodEntries, foodItems, mealItems, meals } from "../db/schema.js";

/**
 * Måltider (D186). Every function takes the owner first and scopes by it (§3).
 *
 * Ingredient rows hang off a meal rather than off a user, so they are reached
 * only through a meal that has already been scoped to the owner, the way
 * template rows were.
 */

export type MealRow = typeof meals.$inferSelect;
export type MealInsert = Omit<typeof meals.$inferInsert, "userId">;
export type MealItemInsert = Omit<typeof mealItems.$inferInsert, "mealId">;

/** An ingredient row with what it is priced from, as its owner sees the food. */
export type MealItemWithFood = typeof mealItems.$inferSelect & {
  food: {
    name: string;
    brand: string | null;
    kcalPer100: string;
    proteinPer100: string | null;
    carbsPer100: string | null;
    fatPer100: string | null;
    fiberPer100: string | null;
    isEstimate: boolean;
  } | null;
};

/**
 * The food a row points at, **as the meal's owner can see it**: shared, or
 * their own private food. A row pointing anywhere else prices as a food that is
 * gone. Nothing lets a meal be written that points elsewhere (the service
 * checks every food it is given), so this is the second lock on the same door.
 */
function visibleTo(ownerId: string): SQL {
  return or(
    eq(foodItems.visibility, "shared"),
    and(eq(foodItems.visibility, "private"), eq(foodItems.createdBy, ownerId)),
  )!;
}

export async function listMeals(userId: string, db: Db): Promise<MealRow[]> {
  return db
    .select()
    .from(meals)
    .where(eq(meals.userId, userId))
    .orderBy(desc(meals.lastLoggedAt), desc(meals.createdAt));
}

export async function findMeal(
  userId: string,
  db: Db,
  mealId: string,
): Promise<MealRow | undefined> {
  const [row] = await db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, userId), eq(meals.id, mealId)))
    .limit(1);
  return row;
}

export async function findMealByClientUuid(
  userId: string,
  db: Db,
  clientUuid: string,
): Promise<MealRow | undefined> {
  const [row] = await db
    .select()
    .from(meals)
    .where(and(eq(meals.userId, userId), eq(meals.clientUuid, clientUuid)))
    .limit(1);
  return row;
}

/**
 * The ingredient rows of these meals, in order, with their food.
 *
 * Joined through `meals` on the owner, so an id that is not theirs returns
 * nothing rather than somebody else's rows.
 */
export async function listMealItems(
  /** The meals' owner, whose view of each food prices it. */
  userId: string,
  db: Db,
  mealIds: readonly string[],
): Promise<MealItemWithFood[]> {
  if (mealIds.length === 0) return [];

  const rows = await db
    .select({
      item: mealItems,
      name: foodItems.name,
      brand: foodItems.brand,
      kcalPer100: foodItems.kcalPer100,
      proteinPer100: foodItems.proteinPer100,
      carbsPer100: foodItems.carbsPer100,
      fatPer100: foodItems.fatPer100,
      fiberPer100: foodItems.fiberPer100,
      isEstimate: foodItems.isEstimate,
    })
    .from(mealItems)
    .innerJoin(meals, and(eq(meals.id, mealItems.mealId), eq(meals.userId, userId)))
    .leftJoin(foodItems, and(eq(foodItems.id, mealItems.foodItemId), visibleTo(userId)))
    .where(inArray(mealItems.mealId, [...mealIds]))
    .orderBy(asc(mealItems.mealId), asc(mealItems.position));

  return rows.map((row) => ({
    ...row.item,
    food:
      row.name === null || row.kcalPer100 === null
        ? null
        : {
            name: row.name,
            brand: row.brand,
            kcalPer100: row.kcalPer100,
            proteinPer100: row.proteinPer100,
            carbsPer100: row.carbsPer100,
            fatPer100: row.fatPer100,
            fiberPer100: row.fiberPer100,
            isEstimate: row.isEstimate ?? false,
          },
  }));
}

/**
 * Idempotent on `(user_id, client_uuid)` (§3): a create that is sent twice is
 * one meal. The second call finds the first rather than failing.
 */
export async function insertMeal(
  userId: string,
  db: Db,
  values: MealInsert,
): Promise<{ row: MealRow; created: boolean }> {
  const [row] = await db
    .insert(meals)
    .values({ ...values, userId })
    .onConflictDoNothing({ target: [meals.userId, meals.clientUuid] })
    .returning();
  if (row) return { row, created: true };

  const existing = await findMealByClientUuid(userId, db, values.clientUuid);
  if (!existing) throw new Error("insertMeal found neither a new row nor the old one");
  return { row: existing, created: false };
}

export async function replaceMealItems(
  userId: string,
  db: Db,
  mealId: string,
  items: readonly MealItemInsert[],
): Promise<void> {
  const meal = await findMeal(userId, db, mealId);
  if (!meal) return;

  await db.delete(mealItems).where(eq(mealItems.mealId, mealId));
  if (items.length === 0) return;
  await db.insert(mealItems).values(items.map((item) => ({ ...item, mealId })));
}

export async function updateMeal(
  userId: string,
  db: Db,
  mealId: string,
  values: Partial<Pick<MealInsert, "name" | "portions" | "defaultMealSlot" | "photoKey" | "photoUpdatedAt" | "sharedAt">>,
): Promise<MealRow | undefined> {
  const [row] = await db
    .update(meals)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(meals.userId, userId), eq(meals.id, mealId)))
    .returning();
  return row;
}

/** Returns the removed row, so its photo can follow it (item 6), or nothing. */
export async function deleteMeal(
  userId: string,
  db: Db,
  mealId: string,
): Promise<MealRow | undefined> {
  const [row] = await db
    .delete(meals)
    .where(and(eq(meals.userId, userId), eq(meals.id, mealId)))
    .returning();
  return row;
}

/** Counted once per logging, the first time its rows are written. */
export async function touchMeal(userId: string, db: Db, mealId: string): Promise<void> {
  await db
    .update(meals)
    .set({ lastLoggedAt: new Date(), loggedCount: sql`${meals.loggedCount} + 1` })
    .where(and(eq(meals.userId, userId), eq(meals.id, mealId)));
}

/** Whether this logging already wrote its rows: the replay test. */
export async function mealLogExists(
  userId: string,
  db: Db,
  mealLogUuid: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: foodEntries.id })
    .from(foodEntries)
    .where(and(eq(foodEntries.userId, userId), eq(foodEntries.mealLogUuid, mealLogUuid)))
    .limit(1);
  return row !== undefined;
}

/**
 * How many times each meal was logged since `since`, by distinct logging.
 *
 * Read from the rows the loggings wrote, so there is no second counter to
 * drift: a logging whose rows were all removed no longer counts, which is the
 * honest answer to "how often do I eat this". By `logged_at`, the moment of
 * logging, because the question is how often somebody reaches for it; a
 * backfilled Tuesday is still a reach made today.
 */
export async function recentMealLogs(
  userId: string,
  db: Db,
  since: Date,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      mealId: foodEntries.mealId,
      logs: sql<number>`count(distinct ${foodEntries.mealLogUuid})::int`,
    })
    .from(foodEntries)
    .where(
      and(
        eq(foodEntries.userId, userId),
        isNotNull(foodEntries.mealId),
        gte(foodEntries.loggedAt, since),
      ),
    )
    .groupBy(foodEntries.mealId);

  return new Map(
    rows.filter((row) => row.mealId !== null).map((row) => [row.mealId as string, Number(row.logs)]),
  );
}
