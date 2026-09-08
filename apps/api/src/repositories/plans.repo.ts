import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { plans } from "../db/schema.js";

export type PlanRow = typeof plans.$inferSelect;
export type PlanInsert = Omit<typeof plans.$inferInsert, "userId">;

export async function insertPlan(
  userId: string,
  db: Db,
  values: PlanInsert,
): Promise<PlanRow> {
  const [row] = await db
    .insert(plans)
    .values({ ...values, userId })
    .returning();
  if (!row) throw new Error("insertPlan returned no row");
  return row;
}

/**
 * Scoped by user id as well as plan id. The id is a uuid and unguessable, but
 * "unguessable" is not an access control — the WHERE clause is.
 */
export async function findPlan(
  userId: string,
  db: Db,
  planId: string,
): Promise<PlanRow | undefined> {
  const [row] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.userId, userId), eq(plans.id, planId)))
    .limit(1);
  return row;
}

export async function findActivePlan(userId: string, db: Db): Promise<PlanRow | undefined> {
  const [row] = await db
    .select()
    .from(plans)
    .where(and(eq(plans.userId, userId), eq(plans.status, "active")))
    .orderBy(desc(plans.createdAt))
    .limit(1);
  return row;
}

export async function listPlans(userId: string, db: Db): Promise<PlanRow[]> {
  return db
    .select()
    .from(plans)
    .where(eq(plans.userId, userId))
    .orderBy(desc(plans.createdAt));
}

export async function updatePlan(
  userId: string,
  db: Db,
  planId: string,
  values: Partial<PlanInsert>,
): Promise<PlanRow | undefined> {
  const [row] = await db
    .update(plans)
    .set(values)
    .where(and(eq(plans.userId, userId), eq(plans.id, planId)))
    .returning();
  return row;
}
