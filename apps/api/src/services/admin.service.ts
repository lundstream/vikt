import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import {
  adminLog,
  invites,
  outboundEmail,
  sessions,
  users,
} from "../db/schema.js";
import { mintInvite } from "./invite.service.js";
import { requestReset } from "./reset.service.js";
import type { Env } from "../env.js";

/**
 * Administration (D95).
 *
 * The only functions in this codebase that deliberately reach across users, so
 * two rules apply to all of them:
 *
 * **Every action is logged with who took it.** These are things one person did
 * to another person's account, and the record has to outlive the action. The
 * log is written in the same call as the action rather than by the route, so a
 * new admin endpoint cannot forget to write one.
 *
 * **The admin never sees or sets a password.** A reset on someone's behalf
 * queues the identical mail the user would have requested; the admin gets a
 * confirmation that it was queued and nothing else. An admin who could set a
 * password could sign in as that person, and nothing in the audit log would
 * distinguish that from the person signing in themselves.
 */

export type AdminActor = { id: string; email: string };

/** Writes the audit row. Called by every function below, never by a route. */
async function record(
  db: Db,
  actor: AdminActor,
  action: string,
  subject: string | null,
  detail: string | null = null,
): Promise<void> {
  await db.insert(adminLog).values({
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    subject,
    detail,
  });
}

/* ------------------------------------------------------------------ users */

export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  /** The newest session's creation, which is the closest thing to "last seen". */
  lastSeenAt: string | null;
  disabledAt: string | null;
  isAdmin: boolean;
};

/**
 * Everyone, with the last time each was seen.
 *
 * "Last seen" is the newest session row rather than a column updated on every
 * request: a `last_seen_at` write per request is a write per request, and the
 * question this answers — is this account still in use — is answered just as
 * well by when they last signed in.
 */
export async function listUsers(db: Db): Promise<AdminUser[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      createdAt: users.createdAt,
      disabledAt: users.disabledAt,
      isAdmin: users.isAdmin,
      lastSeenAt: sql<Date | null>`max(${sessions.createdAt})`,
    })
    .from(users)
    .leftJoin(sessions, eq(sessions.userId, users.id))
    .groupBy(users.id)
    .orderBy(desc(users.createdAt));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    isAdmin: row.isAdmin,
  }));
}

/**
 * Disabling, and its immediate consequence.
 *
 * Sessions are dropped as well as the flag being set, because a disabled
 * account with a live session is an account that is still signed in. The flag
 * alone would take effect at the end of a session's life, which for this app is
 * weeks.
 */
export async function setUserDisabled(
  db: Db,
  actor: AdminActor,
  userId: string,
  disabled: boolean,
): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(eq(users.id, userId))
    .returning({ email: users.email });

  if (updated.length === 0) return false;

  if (disabled) await db.delete(sessions).where(eq(sessions.userId, userId));

  await record(db, actor, disabled ? "user.disable" : "user.enable", userId, updated[0]!.email);
  return true;
}

/**
 * What deleting an account would remove, counted before anyone confirms.
 *
 * Shown to the admin as a list, because "delete this user" is the one
 * irreversible action in the app and the person taking it should see the size
 * of it first. The counts come from the same cascade the delete relies on.
 */
export type DeletionPreview = {
  email: string;
  weights: number;
  foodEntries: number;
  dailyLogs: number;
  photos: number;
};

export async function previewDeletion(
  db: Db,
  userId: string,
): Promise<DeletionPreview | null> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return null;

  const count = async (table: string): Promise<number> => {
    const result = await db.execute(
      sql`select count(*)::int as n from ${sql.raw(table)} where user_id = ${userId}`,
    );
    const rows = result as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  };

  return {
    email: user.email,
    weights: await count("weight_log"),
    foodEntries: await count("food_entries"),
    dailyLogs: await count("daily_log"),
    /**
     * The rows exist; the files do not yet (phase 7 is not built).
     *
     * Counted anyway and named in the preview, because D10 puts the files on a
     * volume **outside the database**: the cascade removes these rows and will
     * not remove a single file. Whoever builds that feature has to delete them
     * here, and this line is where they will look.
     */
    photos: await count("photos"),
  };
}

/**
 * Deleting an account.
 *
 * Every user-owned table cascades from `users.id`, which is what makes this one
 * statement rather than twenty. The exception is photos, which live on a volume
 * outside the database by D10: when that feature exists, the files have to be
 * removed here, and the preview above names them so the gap is visible rather
 * than discovered later.
 */
export async function deleteUser(
  db: Db,
  actor: AdminActor,
  userId: string,
): Promise<DeletionPreview | null> {
  const preview = await previewDeletion(db, userId);
  if (!preview) return null;

  await db.delete(users).where(eq(users.id, userId));

  await record(
    db,
    actor,
    "user.delete",
    userId,
    `${preview.email}: ${preview.weights} weights, ${preview.foodEntries} food entries, ` +
      `${preview.dailyLogs} daily logs`,
  );

  return preview;
}

/**
 * A reset link, sent on someone's behalf.
 *
 * The identical mail the user would have got by asking. The admin never learns
 * the token and never sets a password: an admin who could set one could sign in
 * as that person, and no audit log can tell that apart from the person signing
 * in themselves.
 */
export async function resetForUser(
  db: Db,
  env: Env,
  actor: AdminActor,
  userId: string,
): Promise<boolean> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return false;

  await requestReset(db, env, user.email);
  await record(db, actor, "user.reset", userId, user.email);
  return true;
}

/* ---------------------------------------------------------------- invites */

export type AdminInvite = {
  code: string;
  createdAt: string;
  usedAt: string | null;
  expiresAt: string | null;
};

export async function listInvites(db: Db): Promise<AdminInvite[]> {
  const rows = await db.select().from(invites).orderBy(desc(invites.createdAt)).limit(200);
  return rows.map((row) => ({
    code: row.code,
    createdAt: row.createdAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }));
}

export async function mintInviteAs(db: Db, actor: AdminActor): Promise<string> {
  const { code } = await mintInvite(db, { createdBy: actor.id });
  await record(db, actor, "invite.mint", code);
  return code;
}

/**
 * Revoking an unused code.
 *
 * Only unused ones: a used code is the record of how an existing account came
 * to exist, and deleting it would leave that account unexplained. The
 * `isNull(usedAt)` in the predicate is what enforces that rather than a check
 * before the delete, so two concurrent calls cannot both succeed.
 */
export async function revokeInvite(
  db: Db,
  actor: AdminActor,
  code: string,
): Promise<boolean> {
  const gone = await db
    .delete(invites)
    .where(and(eq(invites.code, code), isNull(invites.usedAt)))
    .returning({ code: invites.code });

  if (gone.length === 0) return false;
  await record(db, actor, "invite.revoke", code);
  return true;
}

/* ------------------------------------------------------------------- mail */

/**
 * Putting a failed message back in the queue.
 *
 * Resets the attempt count as well as the status, because the operator has
 * presumably fixed whatever was wrong and the backoff from the previous run is
 * about a problem that no longer exists.
 */
export async function retryMail(
  db: Db,
  actor: AdminActor,
  id: string,
): Promise<boolean> {
  const updated = await db
    .update(outboundEmail)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null })
    .where(eq(outboundEmail.id, id))
    .returning({ to: outboundEmail.toAddress });

  if (updated.length === 0) return false;
  await record(db, actor, "mail.retry", id, updated[0]!.to);
  return true;
}

/* -------------------------------------------------------------------- log */

export async function listAdminLog(db: Db, limit = 200) {
  const rows = await db.select().from(adminLog).orderBy(desc(adminLog.createdAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    actorEmail: row.actorEmail,
    action: row.action,
    subject: row.subject,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }));
}
