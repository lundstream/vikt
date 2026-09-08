import { eq } from "drizzle-orm";
import { verifyPassword } from "../auth/password.js";
import type { Db } from "../db/index.js";
import { adminLog, users } from "../db/schema.js";
import { previewDeletion, type DeletionPreview } from "./admin.service.js";

/**
 * What a user can do to their own account (D107).
 *
 * Two things: agree to the privacy text, and leave.
 *
 * Both are deliberately here rather than in `admin.service.ts`, even though the
 * deletion reuses that file's preview and cascade. The difference is who is
 * acting: an admin deleting somebody else is an administrative act on another
 * person, and a person deleting themselves is not. The audit row says which,
 * and a screen that mixed the two would eventually let one call the other.
 */

/** Records consent, once. A second call is a no-op rather than a new date. */
export async function acceptTerms(userId: string, db: Db): Promise<string> {
  const [row] = await db
    .select({ consentedAt: users.consentedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (row?.consentedAt) return row.consentedAt.toISOString();

  const now = new Date();
  await db.update(users).set({ consentedAt: now }).where(eq(users.id, userId));
  return now.toISOString();
}

/** What deleting this account would remove, for the confirmation (D95, D107). */
export async function previewOwnDeletion(
  userId: string,
  db: Db,
): Promise<DeletionPreview | null> {
  return previewDeletion(db, userId);
}

export type DeleteOutcome =
  | { ok: true; removed: DeletionPreview }
  | { ok: false; reason: "wrong_password" | "not_found" };

/**
 * Deletes the caller's own account.
 *
 * **The password is required**, and it is the whole security of this: a session
 * cookie is enough to read and write, and it is not enough to destroy. A
 * borrowed phone, a session left open on a shared machine, or a stolen cookie
 * should not be able to erase a year of somebody's logging in one tap.
 *
 * Everything else is the same cascade an admin delete performs, which is the
 * point: one path, one set of foreign keys, one thing to get right. Photos on
 * disk go with it (D10), sessions end because the rows are gone, and the audit
 * row records that the person did it themselves rather than that it happened.
 */
export async function deleteOwnAccount(
  userId: string,
  db: Db,
  password: string,
  /**
   * Removes the account's photo files (D10).
   *
   * Injected rather than imported because Phase 7 has not shipped: there is no
   * photo storage module to call yet, and passing the responsibility in means
   * this file does not have to be edited when there is one. The route passes a
   * no-op today, and the parameter is what makes the gap visible.
   */
  removePhotos: (userId: string) => Promise<void>,
): Promise<DeleteOutcome> {
  const [row] = await db
    .select({ email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };

  if (!(await verifyPassword(row.passwordHash, password))) {
    return { ok: false, reason: "wrong_password" };
  }

  const removed = await previewDeletion(db, userId);
  if (!removed) return { ok: false, reason: "not_found" };

  /**
   * Photos first, and outside the transaction on purpose.
   *
   * Files on disk cannot roll back. Removing them before the row means the
   * worst case is a deleted photo whose account survived a failed transaction,
   * which the user can see and re-upload. The other order's worst case is an
   * orphaned directory of somebody's body photos on a server they believe they
   * have left, which is not a thing to leave to chance (D10).
   */
  await removePhotos(userId);

  /**
   * The audit row is written **before** the delete, because `actor_id`
   * references `users` and the row is about to be gone. `actorEmail` is the
   * snapshot that keeps it readable, exactly as D95 intended for the case of an
   * admin being deleted.
   */
  await db.insert(adminLog).values({
    actorId: userId,
    actorEmail: row.email,
    action: "account.self_delete",
    subject: userId,
    detail: `${removed.weights} vägningar, ${removed.foodEntries} matrader`,
  });

  await db.delete(users).where(eq(users.id, userId));

  return { ok: true, removed };
}
