import { and, asc, eq, gte, lte, ne, type SQL } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { manualIntake } from "../db/schema.js";

export type ManualIntakeRow = typeof manualIntake.$inferSelect;

/**
 * `manual_intake` — one number for the day until phase 3 brings real food
 * logging. Same shape as `weight.repo.ts`: `userId` first, in every WHERE, and
 * an idempotent upsert on `(user_id, client_uuid)`.
 */

export type ManualIntakeInsert = {
  clientUuid: string;
  localDate: string;
  kcal: number;
  proteinG: number | null;
  note: string | null;
};

export async function upsertManualIntakeByClientUuid(
  userId: string,
  db: Db,
  values: ManualIntakeInsert,
): Promise<ManualIntakeRow> {
  const [row] = await db
    .insert(manualIntake)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [manualIntake.userId, manualIntake.clientUuid],
      set: {
        localDate: values.localDate,
        kcal: values.kcal,
        proteinG: values.proteinG,
        note: values.note,
      },
    })
    .returning();

  if (!row) throw new Error("upsertManualIntakeByClientUuid returned no row");
  return row;
}

/** Clears any other row holding that day, so the day index cannot reject the upsert. */
export async function deleteIntakeForDayExcept(
  userId: string,
  db: Db,
  localDate: string,
  keepClientUuid: string,
): Promise<void> {
  await db
    .delete(manualIntake)
    .where(
      and(
        eq(manualIntake.userId, userId),
        eq(manualIntake.localDate, localDate),
        ne(manualIntake.clientUuid, keepClientUuid),
      ),
    );
}

/**
 * Removes one manual row.
 *
 * A manual row **owns its day** (D44): while it exists, that day's food entries
 * are not what the app reports as eaten. So deleting it is not a tidy-up, it is
 * how someone who typed a rough total in the morning and logged real meals in
 * the evening gets the real meals counted. Nothing else can do that, which is
 * why "there is no delete" was not a small gap here.
 */
export async function deleteManualIntake(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(manualIntake)
    .where(and(eq(manualIntake.userId, userId), eq(manualIntake.id, id)))
    .returning({ id: manualIntake.id });

  return rows.length > 0;
}

export async function listManualIntake(
  userId: string,
  db: Db,
  range: { from?: string | undefined; to?: string | undefined } = {},
): Promise<ManualIntakeRow[]> {
  const filters: SQL[] = [eq(manualIntake.userId, userId)];
  if (range.from) filters.push(gte(manualIntake.localDate, range.from));
  if (range.to) filters.push(lte(manualIntake.localDate, range.to));

  return db
    .select()
    .from(manualIntake)
    .where(and(...filters))
    .orderBy(asc(manualIntake.localDate));
}
