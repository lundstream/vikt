import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminLog, invites, outboundEmail, sessions, users } from "../src/db/schema.js";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";
import { resetRateLimiters } from "../src/routes/public.routes.js";

/**
 * Administration (D95).
 *
 * These are the only endpoints in the app that reach across users, so the tests
 * are about authority as much as about behaviour: who may call them, what is
 * recorded when they do, and what the irreversible one actually removes.
 */

beforeEach(() => resetRateLimiters());

type Ctx = ReturnType<typeof useTestApp>;

async function makeAdmin(db: Awaited<ReturnType<Ctx>>["db"], userId: string) {
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
}

describe("who may reach the admin area", () => {
  const ctx = useTestApp();

  /** Every route, not a sample: a single unguarded one is the whole hole. */
  it("answers 404 to an ordinary account on every route", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const routes: [string, string][] = [
      ["GET", "/api/admin/users"],
      ["GET", "/api/admin/invites"],
      ["GET", "/api/admin/mail"],
      ["GET", "/api/admin/log"],
      ["GET", "/api/admin/invite-requests"],
      ["POST", "/api/admin/invites"],
    ];

    for (const [method, url] of routes) {
      const response = await app.inject({ method: method as "GET", url, headers: auth(user) });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("answers 401 to nobody at all", async () => {
    const { app } = ctx();
    const response = await app.inject({ method: "GET", url: "/api/admin/users" });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Read per request rather than carried in the session, so revoking takes
   * effect now rather than whenever the session happens to expire.
   */
  it("stops working the moment the flag is removed, on the same session", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    expect(
      (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth(admin) }))
        .statusCode,
    ).toBe(200);

    await db.update(users).set({ isAdmin: false }).where(eq(users.id, admin.userId));

    expect(
      (await app.inject({ method: "GET", url: "/api/admin/users", headers: auth(admin) }))
        .statusCode,
    ).toBe(404);
  });
});

describe("users", () => {
  const ctx = useTestApp();

  it("lists everyone with when they were created and last seen", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const other = await createUser(app, db);

    const body = (
      await app.inject({ method: "GET", url: "/api/admin/users", headers: auth(admin) })
    ).json();

    const row = body.users.find((u: { id: string }) => u.id === other.userId);
    expect(row.email).toBe(other.email);
    expect(row.createdAt).toMatch(/^\d{4}-/);
    // They signed in when the factory registered them.
    expect(row.lastSeenAt).toMatch(/^\d{4}-/);
    expect(row.disabledAt).toBeNull();
  });

  /**
   * Disabling has to bite immediately. The flag alone would take effect
   * whenever the session expired, which for this app is weeks.
   */
  it("disabling drops the account's sessions there and then", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const victim = await createUser(app, db);

    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: auth(victim) })).statusCode,
    ).toBe(200);

    await app.inject({
      method: "POST",
      url: `/api/admin/users/${victim.userId}/disabled`,
      headers: auth(admin),
      payload: { disabled: true },
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: auth(victim) })).statusCode,
    ).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, victim.userId))).toEqual([]);
  });

  it("re-enabling clears the flag", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const victim = await createUser(app, db);

    for (const disabled of [true, false]) {
      await app.inject({
        method: "POST",
        url: `/api/admin/users/${victim.userId}/disabled`,
        headers: auth(admin),
        payload: { disabled },
      });
    }

    const [row] = await db.select().from(users).where(eq(users.id, victim.userId));
    expect(row!.disabledAt).toBeNull();
  });

  /**
   * The one irreversible action in the app, so the admin is shown its size
   * before confirming — from the same tables the cascade will empty.
   */
  it("says what a delete would remove before it removes it", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const victim = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(victim),
      payload: {
        clientUuid: crypto.randomUUID(),
        localDate: localDate(),
        weightKg: 82.4,
      },
    });

    const preview = (
      await app.inject({
        method: "GET",
        url: `/api/admin/users/${victim.userId}/deletion`,
        headers: auth(admin),
      })
    ).json();

    expect(preview.email).toBe(victim.email);
    expect(preview.weights).toBe(1);
    // Named even at zero, because D10 puts the files outside the database and
    // the cascade will not touch them.
    expect(preview.photos).toBe(0);
  });

  it("deleting takes the account and everything hanging off it", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const victim = await createUser(app, db);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${victim.userId}`,
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(users).where(eq(users.id, victim.userId))).toEqual([]);
    expect(await db.select().from(sessions).where(eq(sessions.userId, victim.userId))).toEqual([]);
  });

  /**
   * The admin never learns a password. A reset on someone's behalf is the
   * identical mail the user would have asked for.
   */
  it("a reset on someone's behalf queues their mail and reveals nothing", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const victim = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${victim.userId}/reset`,
      headers: auth(admin),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json())).toEqual(["ok", "emailed"]);

    const [mail] = await db.select().from(outboundEmail);
    expect(mail!.template).toBe("password_reset");
    expect(mail!.toAddress.toLowerCase()).toBe(victim.email.toLowerCase());
  });
});

describe("invites", () => {
  const ctx = useTestApp();

  it("mints a code that registers an account, and lists it", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    const { code } = (
      await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth(admin) })
    ).json();

    const listed = (
      await app.inject({ method: "GET", url: "/api/admin/invites", headers: auth(admin) })
    ).json();
    expect(listed.invites.map((i: { code: string }) => i.code)).toContain(code);

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: code,
        email: "new@example.test",
        password: "a-perfectly-fine-password",
        displayName: "New",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });
    expect(registered.statusCode).toBe(201);
  });

  it("revokes an unused code", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    const { code } = (
      await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth(admin) })
    ).json();

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/admin/invites/${code}`,
          headers: auth(admin),
        })
      ).statusCode,
    ).toBe(200);

    expect(await db.select().from(invites).where(eq(invites.code, code))).toEqual([]);
  });

  /** A used code is the record of how an account came to exist. */
  it("refuses to revoke a code that has been used", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    const { code } = (
      await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth(admin) })
    ).json();

    await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: code,
        email: "new@example.test",
        password: "a-perfectly-fine-password",
        displayName: "New",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/invites/${code}`,
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(404);
    expect(await db.select().from(invites).where(eq(invites.code, code))).toHaveLength(1);
  });
});

describe("the audit log", () => {
  const ctx = useTestApp();

  /**
   * Written by the service rather than by the route, so a new endpoint cannot
   * forget one. This checks the property that matters: every action taken
   * leaves a row naming who took it.
   */
  it("records who did what", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const victim = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: `/api/admin/users/${victim.userId}/disabled`,
      headers: auth(admin),
      payload: { disabled: true },
    });
    await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth(admin) });

    const body = (
      await app.inject({ method: "GET", url: "/api/admin/log", headers: auth(admin) })
    ).json();

    const actions = body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("user.disable");
    expect(actions).toContain("invite.mint");
    for (const entry of body.entries) {
      expect(entry.actorEmail).toBe(admin.email);
    }
  });

  /**
   * The log outlives its author. An entry that vanished with the admin's
   * account would erase exactly the history worth keeping.
   */
  it("survives the deletion of the admin who wrote it", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);
    const other = await createUser(app, db);
    await makeAdmin(db, other.userId);

    await app.inject({ method: "POST", url: "/api/admin/invites", headers: auth(admin) });
    await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${admin.userId}`,
      headers: auth(other),
    });

    const rows = await db.select().from(adminLog);
    const minted = rows.find((row) => row.action === "invite.mint");
    expect(minted).toBeDefined();
    // The id is gone with the account; the address is what keeps it readable.
    expect(minted!.actorId).toBeNull();
    expect(minted!.actorEmail).toBe(admin.email);
  });
});
