import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { milestones, savingsEvents, savingsOffsets, savingsRules } from "../db/schema.js";

/**
 * `milestones`, `savings_rules`, `savings_offsets` and `savings_events`.
 *
 * `userId` first and in the WHERE on every function, including the ones where
 * the row id is already unique (CLAUDE.md §3). Nothing here ever accepts an
 * unscoped filter, and the offset writer checks the rule belongs to the caller
 * before inserting against it: a rule id is guessable and an offset against
 * someone else's rule would silently alter their pot.
 */

export type MilestoneRow = typeof milestones.$inferSelect;
export type SavingsRuleRow = typeof savingsRules.$inferSelect;
export type SavingsOffsetRow = typeof savingsOffsets.$inferSelect;
export type SavingsEventRow = typeof savingsEvents.$inferSelect;

/* ------------------------------------------------------------- milestones */

export type MilestoneInsert = {
  label: string;
  metric: MilestoneRow["metric"];
  targetValue: string;
  rewardText: string | null;
  rewardCostSek: string | null;
  sortOrder: number;
};

export async function listMilestones(userId: string, db: Db): Promise<MilestoneRow[]> {
  return db
    .select()
    .from(milestones)
    .where(eq(milestones.userId, userId))
    .orderBy(asc(milestones.sortOrder), asc(milestones.createdAt));
}

export async function findMilestone(
  userId: string,
  db: Db,
  id: string,
): Promise<MilestoneRow | null> {
  const [row] = await db
    .select()
    .from(milestones)
    .where(and(eq(milestones.userId, userId), eq(milestones.id, id)))
    .limit(1);

  return row ?? null;
}

/**
 * An existing milestone on the same metric and target, if there is one.
 *
 * Used to refuse a duplicate at creation (D49). Scoped by user id, so it can
 * only ever see the caller's own.
 */
export async function findMilestoneByTarget(
  userId: string,
  db: Db,
  metric: MilestoneRow["metric"],
  targetValue: string,
): Promise<MilestoneRow | null> {
  const [row] = await db
    .select()
    .from(milestones)
    .where(
      and(
        eq(milestones.userId, userId),
        eq(milestones.metric, metric),
        eq(milestones.targetValue, targetValue),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function insertMilestone(
  userId: string,
  db: Db,
  values: MilestoneInsert,
): Promise<MilestoneRow> {
  const [row] = await db
    .insert(milestones)
    .values({ userId, ...values })
    .returning();

  if (!row) throw new Error("insertMilestone returned no row");
  return row;
}

export async function updateMilestone(
  userId: string,
  db: Db,
  id: string,
  values: Partial<MilestoneInsert>,
): Promise<MilestoneRow | null> {
  const [row] = await db
    .update(milestones)
    .set(values)
    .where(and(eq(milestones.userId, userId), eq(milestones.id, id)))
    .returning();

  return row ?? null;
}

export async function deleteMilestone(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(milestones)
    .where(and(eq(milestones.userId, userId), eq(milestones.id, id)))
    .returning({ id: milestones.id });

  return rows.length > 0;
}

/**
 * Stamp a milestone as reached.
 *
 * `WHERE achieved_at IS NULL` is load-bearing, not belt-and-braces: two writes
 * arriving together (the offline queue replaying, or a weight and a measurement
 * saved in the same second) would otherwise both stamp it, moving `achieved_at`
 * forward and re-firing the celebration. This makes the second one a no-op at
 * the database rather than in a check-then-write race above it.
 */
export async function markAchieved(
  userId: string,
  db: Db,
  id: string,
  achievedValue: string,
  achievedAt: Date,
): Promise<MilestoneRow | null> {
  const [row] = await db
    .update(milestones)
    .set({ achievedAt, achievedValue })
    .where(
      and(
        eq(milestones.userId, userId),
        eq(milestones.id, id),
        isNull(milestones.achievedAt),
      ),
    )
    .returning();

  return row ?? null;
}

/**
 * The one milestone waiting to be celebrated, oldest first.
 *
 * Achieved and not yet celebrated: two separate timestamps, because that pair
 * is the only thing that makes "show it once" representable (D38).
 */
export async function findUncelebrated(
  userId: string,
  db: Db,
): Promise<MilestoneRow | null> {
  const rows = await db
    .select()
    .from(milestones)
    .where(
      and(
        eq(milestones.userId, userId),
        isNull(milestones.celebratedAt),
        isNotNull(milestones.achievedAt),
      ),
    )
    .orderBy(asc(milestones.achievedAt))
    .limit(1);

  return rows[0] ?? null;
}

/** Never clears it: acknowledging twice is a no-op, not a reset. */
export async function markCelebrated(
  userId: string,
  db: Db,
  id: string,
  at: Date,
): Promise<void> {
  await db
    .update(milestones)
    .set({ celebratedAt: at })
    .where(
      and(
        eq(milestones.userId, userId),
        eq(milestones.id, id),
        isNull(milestones.celebratedAt),
      ),
    );
}

export async function markRewardClaimed(
  userId: string,
  db: Db,
  id: string,
  at: Date,
): Promise<MilestoneRow | null> {
  const [row] = await db
    .update(milestones)
    .set({ rewardClaimedAt: at })
    .where(
      and(
        eq(milestones.userId, userId),
        eq(milestones.id, id),
        isNull(milestones.rewardClaimedAt),
      ),
    )
    .returning();

  return row ?? null;
}

/* ---------------------------------------------------------------- savings */

export type SavingsRuleInsert = {
  label: string;
  amountSek: string;
  cadence: SavingsRuleRow["cadence"];
  startDate: string;
  endDate: string | null;
  active: boolean;
};

export async function listSavingsRules(
  userId: string,
  db: Db,
): Promise<SavingsRuleRow[]> {
  return db
    .select()
    .from(savingsRules)
    .where(eq(savingsRules.userId, userId))
    .orderBy(asc(savingsRules.startDate));
}

export async function findSavingsRule(
  userId: string,
  db: Db,
  id: string,
): Promise<SavingsRuleRow | null> {
  const [row] = await db
    .select()
    .from(savingsRules)
    .where(and(eq(savingsRules.userId, userId), eq(savingsRules.id, id)))
    .limit(1);

  return row ?? null;
}

export async function insertSavingsRule(
  userId: string,
  db: Db,
  values: SavingsRuleInsert,
): Promise<SavingsRuleRow> {
  const [row] = await db
    .insert(savingsRules)
    .values({ userId, ...values })
    .returning();

  if (!row) throw new Error("insertSavingsRule returned no row");
  return row;
}

export async function updateSavingsRule(
  userId: string,
  db: Db,
  id: string,
  values: Partial<SavingsRuleInsert>,
): Promise<SavingsRuleRow | null> {
  const [row] = await db
    .update(savingsRules)
    .set(values)
    .where(and(eq(savingsRules.userId, userId), eq(savingsRules.id, id)))
    .returning();

  return row ?? null;
}

/**
 * Offsets cascade with the rule (`savings_offsets.rule_id ON DELETE CASCADE`),
 * so a deleted rule takes its "I did buy the lunch after all" rows with it. It
 * has to: an offset against a rule that no longer exists is a deduction from
 * nothing, and the pot accrues on read, so it would be recomputed forever.
 */
export async function deleteSavingsRule(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(savingsRules)
    .where(and(eq(savingsRules.userId, userId), eq(savingsRules.id, id)))
    .returning({ id: savingsRules.id });

  return rows.length > 0;
}

export async function listOffsets(
  userId: string,
  db: Db,
): Promise<SavingsOffsetRow[]> {
  return db
    .select()
    .from(savingsOffsets)
    .where(eq(savingsOffsets.userId, userId))
    .orderBy(asc(savingsOffsets.localDate));
}

/**
 * Idempotent on `(rule_id, local_date)`, which is a natural key: filing "I did
 * buy lunch on Tuesday" twice is one fact, not two deductions.
 */
export async function upsertOffset(
  userId: string,
  db: Db,
  values: { ruleId: string; localDate: string; note: string | null },
): Promise<SavingsOffsetRow> {
  const [row] = await db
    .insert(savingsOffsets)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: [savingsOffsets.ruleId, savingsOffsets.localDate],
      set: { note: values.note },
    })
    .returning();

  if (!row) throw new Error("upsertOffset returned no row");
  return row;
}

/** Scoped by user id, so it can only remove the caller's own offset. */
export async function deleteOffset(
  userId: string,
  db: Db,
  ruleId: string,
  localDate: string,
): Promise<boolean> {
  const rows = await db
    .delete(savingsOffsets)
    .where(
      and(
        eq(savingsOffsets.userId, userId),
        eq(savingsOffsets.ruleId, ruleId),
        eq(savingsOffsets.localDate, localDate),
      ),
    )
    .returning({ id: savingsOffsets.id });

  return rows.length > 0;
}

export async function listSavingsEvents(
  userId: string,
  db: Db,
): Promise<SavingsEventRow[]> {
  return db
    .select()
    .from(savingsEvents)
    .where(eq(savingsEvents.userId, userId))
    .orderBy(asc(savingsEvents.localDate));
}

export async function insertSavingsEvent(
  userId: string,
  db: Db,
  values: {
    localDate: string;
    label: string;
    amountSek: string;
    milestoneId: string | null;
  },
): Promise<SavingsEventRow> {
  const [row] = await db
    .insert(savingsEvents)
    .values({ userId, ...values })
    .returning();

  if (!row) throw new Error("insertSavingsEvent returned no row");
  return row;
}

export async function deleteSavingsEvent(
  userId: string,
  db: Db,
  id: string,
): Promise<boolean> {
  const rows = await db
    .delete(savingsEvents)
    .where(and(eq(savingsEvents.userId, userId), eq(savingsEvents.id, id)))
    .returning({ id: savingsEvents.id });

  return rows.length > 0;
}
