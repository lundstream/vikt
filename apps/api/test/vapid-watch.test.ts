import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { appSettings, pushSubscriptions } from "../src/db/schema.js";
import { checkVapidKey, VAPID_KEY_SETTING } from "../src/lib/vapid-watch.js";

/**
 * Noticing that the VAPID pair changed (D136, amended 2026-09-12).
 *
 * Since 403 stopped deleting anything, a changed key fails **quietly**: every
 * subscription keeps answering 403, reminders stop arriving, and the settings
 * screen still says the device is connected. That is the worst shape for a
 * fault, so the server writes down which key it ran with and says something the
 * next time that is not the key it has.
 *
 * What these hold is that it says it **only** when there is something to say,
 * and that it never refuses, never deletes and always ends up storing the key
 * it is running with — a diagnostic that leaves the record wrong is worse than
 * no diagnostic.
 */

const KEYED = {
  VAPID_PUBLIC_KEY: "public-key-one",
  VAPID_PRIVATE_KEY: "private-key-one",
  VAPID_SUBJECT: "mailto:test@example.test",
} as const;

async function storedKey(db: Parameters<typeof checkVapidKey>[0]) {
  const [row] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, VAPID_KEY_SETTING))
    .limit(1);
  return row?.value ?? null;
}

describe("the first boot", () => {
  const ctx = useTestApp(KEYED);

  it("writes the key down and says nothing alarming", async () => {
    const { app, db } = ctx();

    expect(await checkVapidKey(db, app.config)).toEqual({ status: "first" });
    expect(await storedKey(db)).toBe("public-key-one");
  });
});

describe("a boot with the same key", () => {
  const ctx = useTestApp(KEYED);

  it("finds nothing to report", async () => {
    const { app, db } = ctx();

    await checkVapidKey(db, app.config);
    expect(await checkVapidKey(db, app.config)).toEqual({ status: "unchanged" });
    expect(await storedKey(db)).toBe("public-key-one");
  });
});

describe("a boot with a different key", () => {
  const ctx = useTestApp(KEYED);

  /** The case this exists for: subscriptions that will now answer 403. */
  it("reports how many subscriptions are affected, and deletes none", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await db.insert(pushSubscriptions).values([
      {
        userId: user.userId,
        endpoint: "https://wns2-db5p.notify.windows.com/w/?token=a",
        p256dh: "key",
        auth: "auth",
      },
      {
        userId: user.userId,
        endpoint: "https://fcm.googleapis.com/fcm/send/b",
        p256dh: "key",
        auth: "auth",
      },
    ]);

    // The previous boot's key, written down.
    await db.insert(appSettings).values({ key: VAPID_KEY_SETTING, value: "an-older-key" });

    const check = await checkVapidKey(db, app.config);

    expect(check).toEqual({ status: "changed", subscriptions: 2 });
    // Nothing was removed, which is the whole point.
    expect(await db.select().from(pushSubscriptions)).toHaveLength(2);
    // And the new key is what is remembered, so the next boot is quiet.
    expect(await storedKey(db)).toBe("public-key-one");
  });

  /**
   * Nobody to warn about. An install that has never had a subscription has
   * nobody whose reminders just stopped, and a warning there would be noise on
   * the one boot an operator is most likely to be watching.
   */
  it("says the key changed but counts nobody when there are no subscriptions", async () => {
    const { app, db } = ctx();

    await db.insert(appSettings).values({ key: VAPID_KEY_SETTING, value: "an-older-key" });

    expect(await checkVapidKey(db, app.config)).toEqual({ status: "changed", subscriptions: 0 });
    expect(await storedKey(db)).toBe("public-key-one");
  });
});

describe("with push switched off", () => {
  const ctx = useTestApp();

  /** No keys, nothing to compare, and nothing written to the table. */
  it("does nothing at all", async () => {
    const { app, db } = ctx();

    expect(await checkVapidKey(db, app.config)).toEqual({ status: "off" });
    expect(await storedKey(db)).toBeNull();
  });
});
