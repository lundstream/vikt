import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { sessions } from "../db/schema.js";

export type SessionRow = typeof sessions.$inferSelect;

export async function insertSession(
  userId: string,
  db: Db,
  values: { tokenHash: string; expiresAt: Date; userAgent: string | null },
): Promise<SessionRow> {
  const [row] = await db
    .insert(sessions)
    .values({ userId, ...values })
    .returning();
  if (!row) throw new Error("insertSession returned no row");
  return row;
}

/**
 * Looked up by token hash rather than by user id, because resolving the cookie
 * is what *establishes* which user this is. `sessions_token_key` is unique
 * across the whole table, so there is no cross-user ambiguity to scope away.
 */
export async function findSessionByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<SessionRow | undefined> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/** Logout. Scoped by user id as well as hash so a stale cookie cannot cross users. */
export async function deleteSession(userId: string, db: Db, tokenHash: string): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.tokenHash, tokenHash)));
}

export async function deleteAllSessionsForUser(userId: string, db: Db): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Housekeeping. Not user-owned in the isolation sense — it deletes only dead rows. */
export async function deleteExpiredSessions(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
