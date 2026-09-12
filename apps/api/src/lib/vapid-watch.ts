import { count, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import { appSettings, pushSubscriptions } from "../db/schema.js";
import { pushEnabled } from "./push.js";

/**
 * Notices at boot that the VAPID pair has changed (D136, amended 2026-09-12).
 *
 * Every push subscription is bound to the key pair it was created with. Change
 * the pair — a rotation, a mispaste into the stack's variables, a restore from
 * a backup whose environment differed — and **every** subscription starts
 * answering 403. Since 403 no longer deletes anything, nothing breaks loudly;
 * reminders simply stop arriving, which is the worst way for this to go wrong,
 * because the screen still says the device is connected.
 *
 * So the server writes down which public key it ran with, and says something
 * the next time that is not the key it has.
 *
 * **It refuses nothing and deletes nothing.** Booting is not the moment to
 * decide that a table of subscriptions is rubbish: an operator who mispasted a
 * key wants to paste the right one and carry on, and an operator who really did
 * rotate wants their users to re-enable at their own pace. The line in the log
 * is the whole intervention.
 */

/** The one entry this file owns. */
export const VAPID_KEY_SETTING = "vapid_public_key";

export type VapidCheck =
  | { status: "off" }
  | { status: "first" }
  | { status: "unchanged" }
  | { status: "changed"; subscriptions: number };

/**
 * Compares the configured public key with the stored one, and stores the new.
 *
 * Returns what it found rather than logging it, so the caller decides how loud
 * to be and a test can read the answer.
 */
export async function checkVapidKey(db: Db, env: Env): Promise<VapidCheck> {
  if (!pushEnabled(env)) return { status: "off" };

  const current = env.VAPID_PUBLIC_KEY.trim();

  const [stored] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, VAPID_KEY_SETTING))
    .limit(1);

  if (!stored) {
    await remember(db, current);
    return { status: "first" };
  }

  if (stored.value === current) return { status: "unchanged" };

  /**
   * Counted only when the key actually changed, because on every other boot
   * this would be a query for nothing. An install with no subscriptions has
   * nobody to warn about: there is no one whose reminders just stopped.
   */
  const [row] = await db.select({ total: count() }).from(pushSubscriptions);
  const subscriptions = row?.total ?? 0;

  await remember(db, current);
  return { status: "changed", subscriptions };
}

async function remember(db: Db, key: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: VAPID_KEY_SETTING, value: key })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: key, updatedAt: new Date() },
    });
}
