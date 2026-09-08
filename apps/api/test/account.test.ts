import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";
import { adminLog, users, weightLog } from "../src/db/schema.js";

/**
 * Consent, and leaving (D107).
 *
 * D56 says a capability ships with the tests its sibling has, and the sibling
 * here is the admin deletion in D95. So this covers the same ground from the
 * other side: the preview is honest, the cascade is complete, the audit row
 * says who did it, and the one thing the admin path does not have — the
 * password check — is tested hardest, because it is the whole security of
 * letting a session cookie reach a destructive endpoint.
 */

describe("consent", () => {
  const ctx = useTestApp();

  it("is recorded at registration, with a time", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const me = (await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })).json();
    expect(me.consentedAt).not.toBeNull();
    expect(new Date(me.consentedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  /**
   * The state every account created before this column is in, and the one the
   * app asks about on next sign-in.
   */
  it("can be given later by an account that has none", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ consentedAt: null }).where(eq(users.id, user.userId));

    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })).json().consentedAt,
    ).toBeNull();

    const given = await app.inject({
      method: "POST",
      url: "/api/me/consent",
      headers: auth(user),
    });
    expect(given.statusCode).toBe(200);

    const me = (await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })).json();
    expect(me.consentedAt).not.toBeNull();
  });

  /** Asked once. A second call does not move the date it was actually given. */
  it("keeps the first date rather than the latest", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const first = (
      await app.inject({ method: "POST", url: "/api/me/consent", headers: auth(user) })
    ).json().consentedAt;
    const second = (
      await app.inject({ method: "POST", url: "/api/me/consent", headers: auth(user) })
    ).json().consentedAt;

    expect(second).toBe(first);
  });

  it("is not something an anonymous caller can give", async () => {
    const { app } = ctx();
    expect((await app.inject({ method: "POST", url: "/api/me/consent" })).statusCode).toBe(401);
  });
});

describe("deleting your own account", () => {
  const ctx = useTestApp();

  /** The counts come from the tables the cascade will empty, not from a guess. */
  it("says what it would remove before anything is removed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const day of [0, -1, -2]) {
      await app.inject({
        method: "POST",
        url: "/api/weight",
        headers: auth(user),
        payload: { clientUuid: randomUUID(), localDate: localDate(day), weightKg: 88 },
      });
    }

    const preview = await app.inject({
      method: "GET",
      url: "/api/me/deletion",
      headers: auth(user),
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().weights).toBe(3);
    expect(preview.json().email).toBe(user.email);

    // Nothing has happened yet.
    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })).statusCode,
    ).toBe(200);
  });

  /**
   * The password, which is the whole security of this. A session cookie is
   * enough to read and write and must not be enough to destroy.
   */
  it("refuses a wrong password, and changes nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const refused = await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(user),
      payload: { password: "not-the-password" },
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("wrong_password");

    const still = await db.select().from(users).where(eq(users.id, user.userId));
    expect(still).toHaveLength(1);
  });

  it("refuses an anonymous caller outright", async () => {
    const { app } = ctx();
    const response = await app.inject({
      method: "POST",
      url: "/api/me/delete",
      payload: { password: "anything" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("removes the account and everything that hangs off it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });

    const gone = await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(user),
      payload: { password: user.password },
    });

    expect(gone.statusCode).toBe(200);
    expect(gone.json().removed.weights).toBe(1);

    expect(await db.select().from(users).where(eq(users.id, user.userId))).toHaveLength(0);
    expect(await db.select().from(weightLog).where(eq(weightLog.userId, user.userId))).toHaveLength(
      0,
    );
  });

  /** The session goes with the rows, so the cookie stops working immediately. */
  it("ends the session", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(user),
      payload: { password: user.password },
    });

    const after = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(after.statusCode).toBe(401);
  });

  /**
   * Recorded as done by the person, not as something that happened. The row is
   * written before the delete, because `actor_id` references a user that is
   * about to be gone, and `actorEmail` is what keeps it readable (D95).
   */
  it("is in the audit log, as the user's own act", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const email = user.email;

    await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(user),
      payload: { password: user.password },
    });

    const entries = await db.select().from(adminLog);
    const mine = entries.find((row) => row.action === "account.self_delete");

    expect(mine).toBeTruthy();
    expect(mine!.actorEmail).toBe(email);
    // The foreign key cleared with the account; the snapshot did not.
    expect(mine!.actorId).toBeNull();
  });

  /** One account's deletion is not another's. */
  it("takes only the caller's rows", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(theirs),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 99 },
    });

    await app.inject({
      method: "POST",
      url: "/api/me/delete",
      headers: auth(mine),
      payload: { password: mine.password },
    });

    expect(await db.select().from(users).where(eq(users.id, theirs.userId))).toHaveLength(1);
    expect(
      await db.select().from(weightLog).where(eq(weightLog.userId, theirs.userId)),
    ).toHaveLength(1);
  });
});
