import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { outboundEmail, passwordResets, sessions, users } from "../src/db/schema.js";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { resetRateLimiters } from "../src/routes/public.routes.js";
import { hashToken, RESET_TTL_MS } from "../src/services/reset.service.js";

/**
 * Password reset (D88): the largest usability gain in the app, and its most
 * sensitive surface.
 *
 * Four properties, each tested rather than reasoned about, because each is the
 * kind that looks obviously true in the code and is obviously false in
 * production the one time it is wrong.
 */

beforeEach(() => resetRateLimiters());

describe("asking for a reset link", () => {
  const ctx = useTestApp();

  /**
   * The enumeration property.
   *
   * If the response differed, anyone could ask whether a given person has an
   * account here. For a weight-tracking app that is a more sensitive
   * disclosure than it would be for most.
   */
  it("answers identically whether or not the address exists", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const [known, unknown] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/api/auth/reset/request",
        payload: { email: user.email },
      }),
      app.inject({
        method: "POST",
        url: "/api/auth/reset/request",
        payload: { email: "nobody-at-all@example.test" },
      }),
    ]);

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
  });

  it("queues exactly one mail, and only for the address that exists", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const email of [user.email, "nobody-at-all@example.test"]) {
      await app.inject({
        method: "POST",
        url: "/api/auth/reset/request",
        payload: { email },
      });
    }

    const queued = await db.select().from(outboundEmail);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.toAddress.toLowerCase()).toBe(user.email.toLowerCase());
    expect(queued[0]!.template).toBe("password_reset");
    // Never sent inside the request: it is waiting for the worker.
    expect(queued[0]!.status).toBe("pending");
  });

  /** The token in the mail must not be the token in the database. */
  it("stores the token hashed, never in the clear", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/auth/reset/request",
      payload: { email: user.email },
    });

    const [mail] = await db.select().from(outboundEmail);
    const [row] = await db.select().from(passwordResets);

    const token = /token=([a-f0-9]+)/.exec(mail!.bodyText)?.[1];
    expect(token).toBeDefined();
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.tokenHash).toBe(hashToken(token!));
  });

  it("refuses on volume rather than on the address", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/reset/request",
        payload: { email: user.email },
      });
      codes.push(response.statusCode);
    }

    // Three per address per hour, so the fourth is refused.
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("spending a reset token", () => {
  const ctx = useTestApp();

  async function tokenFor(app: Awaited<ReturnType<typeof ctx>>["app"], db: Awaited<ReturnType<typeof ctx>>["db"], email: string) {
    await app.inject({ method: "POST", url: "/api/auth/reset/request", payload: { email } });
    const [mail] = await db.select().from(outboundEmail);
    return /token=([a-f0-9]+)/.exec(mail!.bodyText)![1]!;
  }

  it("sets the new password and lets it sign in", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const token = await tokenFor(app, db, user.email);

    const reset = await app.inject({
      method: "POST",
      url: "/api/auth/reset/complete",
      payload: { token, password: "a-brand-new-password" },
    });
    expect(reset.statusCode).toBe(200);

    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "a-brand-new-password" },
    });
    expect(signIn.statusCode).toBe(200);
  });

  /** A link that works twice is a link that works for whoever finds it second. */
  it("is single use", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const token = await tokenFor(app, db, user.email);

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/reset/complete",
      payload: { token, password: "a-brand-new-password" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/reset/complete",
      payload: { token, password: "yet-another-password" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
  });

  it("expires", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const token = await tokenFor(app, db, user.email);

    // Age the row past its window rather than waiting an hour for it.
    await db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - RESET_TTL_MS) })
      .where(eq(passwordResets.tokenHash, hashToken(token)));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/reset/complete",
      payload: { token, password: "a-brand-new-password" },
    });
    expect(response.statusCode).toBe(400);
  });

  /**
   * A reset is what someone does when they think another person has their
   * password. Leaving that person signed in makes the reset a gesture.
   */
  it("signs out every existing session for that user", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // The account has a live session: the one `createUser` signed in with.
    const before = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(before.statusCode).toBe(200);

    const token = await tokenFor(app, db, user.email);
    await app.inject({
      method: "POST",
      url: "/api/auth/reset/complete",
      payload: { token, password: "a-brand-new-password" },
    });

    const after = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(after.statusCode).toBe(401);

    const left = await db.select().from(sessions).where(eq(sessions.userId, user.userId));
    expect(left).toEqual([]);
  });

  it("tells every kind of wrong token apart from none of them", async () => {
    const { app, db } = ctx();
    await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/reset/complete",
      payload: { token: "f".repeat(64), password: "a-brand-new-password" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_or_expired");
  });
});

describe("a disabled account", () => {
  const ctx = useTestApp();

  it("gets no reset mail, and the caller cannot tell", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, user.userId));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/reset/request",
      payload: { email: user.email },
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(outboundEmail)).toEqual([]);
  });
});
