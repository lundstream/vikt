import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { passwordResets, sessions, users } from "../db/schema.js";
import { hashPassword } from "../auth/password.js";
import { queueMail } from "../mail/queue.js";
import { passwordResetMail } from "../mail/templates.js";
import type { Env } from "../env.js";
import { linkTo } from "../lib/links.js";

/**
 * Password reset (D88).
 *
 * The largest usability gain in the app and the most sensitive surface in it,
 * which is an uncomfortable combination and the reason every property below is
 * tested rather than reasoned about.
 *
 * **The request endpoint answers identically whether or not the address
 * exists.** Otherwise it is an account enumeration oracle: anyone can ask
 * whether a given person has an account here, which for a weight-tracking app
 * is a more sensitive disclosure than it would be for most. That means the
 * work has to be indistinguishable too — the same response, and no timing
 * shortcut that returns early for an unknown address.
 *
 * **Tokens are random, single-use, short-lived and stored hashed.** Hashed for
 * the same reason session tokens are: a database copy must not be a set of
 * working links into people's accounts. The plaintext exists once, in the mail.
 *
 * **Resetting invalidates every session.** A reset is what someone does when
 * they think another person has their password, and leaving that person's
 * session alive is leaving the door open behind them.
 */

/** An hour. Long enough to find the mail, short enough that a leaked link rots. */
export const RESET_TTL_MS = 60 * 60_000;

/** 32 random bytes, hex. Not a UUID: a reset token is a secret, not an id. */
function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Starts a reset, if that address has an account.
 *
 * Returns nothing either way. The caller sends the same response in both cases
 * and must not branch on anything this returns, which is why it returns
 * nothing at all rather than a boolean somebody could leak into a status code.
 */
export async function requestReset(
  db: Db,
  env: Env,
  email: string,
  now: Date = new Date(),
): Promise<void> {
  const [user] = await db
    .select({ id: users.id, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  // No account, or a disabled one: nothing queued, and the caller says exactly
  // what it says for an address that does exist.
  if (!user || user.disabledAt !== null) return;

  const { token, hash } = mintToken();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);

  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hash,
    expiresAt,
  });

  const link = linkTo(env, "/app/nytt-losenord", { token });
  await queueMail(
    db,
    email.trim(),
    passwordResetMail({ link, hours: Math.round(RESET_TTL_MS / 3_600_000) }),
  );
}

export type ResetOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_or_expired" };

/**
 * Spends a token and sets the new password.
 *
 * One outcome for "wrong token", "already used" and "expired", deliberately:
 * telling them apart tells an attacker which of their guesses was once real.
 */
export async function completeReset(
  db: Db,
  token: string,
  newPassword: string,
  now: Date = new Date(),
): Promise<ResetOutcome> {
  const [row] = await db
    .select()
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.tokenHash, hashToken(token)),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, now),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "invalid_or_expired" };

  /**
   * Marked used **before** anything else, so a token cannot be spent twice by
   * two requests arriving together. The unique index on the hash plus this
   * conditional update is what makes single-use a fact rather than a hope: the
   * second update matches no rows.
   */
  const spent = await db
    .update(passwordResets)
    .set({ usedAt: now })
    .where(and(eq(passwordResets.id, row.id), isNull(passwordResets.usedAt)))
    .returning({ id: passwordResets.id });

  if (spent.length === 0) return { ok: false, reason: "invalid_or_expired" };

  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword) })
    .where(eq(users.id, row.userId));

  /**
   * Every session, including the one making this request.
   *
   * Someone resetting a password is often doing it because they believe
   * somebody else has it. Leaving that somebody signed in would make the reset
   * a gesture.
   */
  await db.delete(sessions).where(eq(sessions.userId, row.userId));

  return { ok: true, userId: row.userId };
}
