import { and, eq, isNull, or, gt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { invites } from "../db/schema.js";

/**
 * `invites` is deliberately NOT user-owned: a code is looked up by someone who
 * has no session yet, which is the whole point of it. It is the one table in
 * this file set that takes no `userId` first parameter, and the exception is
 * noted here so it reads as intentional rather than as an oversight.
 */

export type InviteRow = typeof invites.$inferSelect;

export async function insertInvite(
  db: Db,
  values: { code: string; createdBy: string | null; expiresAt: Date | null },
): Promise<InviteRow> {
  const [row] = await db.insert(invites).values(values).returning();
  if (!row) throw new Error("insertInvite returned no row");
  return row;
}

/**
 * Unused and unexpired, or nothing.
 *
 * The "used" test is `used_at`, not `used_by`. `used_by` is a foreign key with
 * `ON DELETE SET NULL`, so deleting an account silently un-burns the code that
 * created it and hands a stranger a way back in. `used_at` is a plain timestamp
 * that nothing cascades to, so a burnt code stays burnt.
 */
export async function findUsableInvite(db: Db, code: string): Promise<InviteRow | undefined> {
  const [row] = await db
    .select()
    .from(invites)
    .where(
      and(
        eq(invites.code, code),
        isNull(invites.usedAt),
        or(isNull(invites.expiresAt), gt(invites.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Burns the code. The `used_at IS NULL` predicate stays in the WHERE so that two
 * simultaneous registrations with the same code cannot both succeed — the loser
 * updates zero rows and its transaction is rolled back by the caller.
 */
export async function markInviteUsed(
  db: Db,
  code: string,
  usedBy: string,
): Promise<InviteRow | undefined> {
  const [row] = await db
    .update(invites)
    .set({ usedBy, usedAt: new Date() })
    .where(and(eq(invites.code, code), isNull(invites.usedAt)))
    .returning();
  return row;
}
