import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { profiles, users } from "../db/schema.js";

/**
 * `users` and `profiles`.
 *
 * `users` is the identity table itself, so lookups here are by email or by the
 * user's own id — there is no "other user's row" to leak. Everything hanging
 * off a user, `profiles` included, is still keyed on `userId` first.
 */

export type UserRow = typeof users.$inferSelect;
export type ProfileRow = typeof profiles.$inferSelect;

/** Identity lookup at login. Case-insensitive, matching `users_email_key`. */
export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return row;
}

export async function findUserById(userId: string, db: Db): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row;
}

export async function findProfile(userId: string, db: Db): Promise<ProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return row;
}

export async function insertUser(
  db: Db,
  values: {
    email: string;
    passwordHash: string;
    displayName: string;
    /** When consent was given (D107). Never defaulted. */
    consentedAt?: Date;
  },
): Promise<UserRow> {
  const [row] = await db.insert(users).values(values).returning();
  if (!row) throw new Error("insertUser returned no row");
  return row;
}

export async function insertProfile(
  userId: string,
  db: Db,
  values: { heightCm?: string | null; timezone: string },
): Promise<ProfileRow> {
  const [row] = await db
    .insert(profiles)
    .values({ userId, ...values })
    .returning();
  if (!row) throw new Error("insertProfile returned no row");
  return row;
}

export async function updateProfile(
  userId: string,
  db: Db,
  values: Partial<Omit<typeof profiles.$inferInsert, "userId">>,
): Promise<ProfileRow | undefined> {
  const [row] = await db
    .update(profiles)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(profiles.userId, userId))
    .returning();
  return row;
}
