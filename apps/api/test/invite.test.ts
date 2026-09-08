import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invites, users } from "../src/db/schema.js";
import { mintInvite } from "../src/services/invite.service.js";
import { createUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

describe("invite codes", () => {
  it("lets a fresh code through exactly once", async () => {
    const { app, db } = ctx();
    const invite = await mintInvite(db, {});

    const payload = {
      inviteCode: invite.code,
      password: "a-perfectly-fine-password",
      displayName: "First",
      consent: true as const,
      timezone: "Europe/Stockholm",
      heightCm: 180,
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, email: "first@example.test" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { ...payload, email: "second@example.test" },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(422);
    expect(second.json<{ error: string }>().error).toBe("invalid_invite");
  });

  /**
   * Regression for DECISIONS.md D16.
   *
   * `invites.used_by` is a foreign key with `ON DELETE SET NULL`. When the
   * usable-invite check keyed on it, deleting an account cleared the column and
   * handed a spent code back out as valid — account cleanup silently reissued
   * invitations. The flag is `used_at`, which nothing cascades to.
   */
  it("stays burnt after the user who redeemed it is deleted", async () => {
    const { app, db } = ctx();
    const invite = await mintInvite(db, {});

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: invite.code,
        email: "redeemer@example.test",
        password: "a-perfectly-fine-password",
        displayName: "Redeemer",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });
    expect(registered.statusCode).toBe(201);
    const userId = registered.json<{ id: string }>().id;

    await db.delete(users).where(eq(users.id, userId));

    // The cascade really did clear used_by — this is the condition that used to
    // resurrect the code, so assert it rather than assuming it.
    const [row] = await db.select().from(invites).where(eq(invites.code, invite.code));
    expect(row?.usedBy).toBeNull();
    expect(row?.usedAt).not.toBeNull();

    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: invite.code,
        email: "stranger@example.test",
        password: "a-perfectly-fine-password",
        displayName: "Stranger",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });

    expect(reuse.statusCode).toBe(422);
    expect(reuse.json<{ error: string }>().error).toBe("invalid_invite");
  });

  it("refuses an expired code", async () => {
    const { app, db } = ctx();
    const invite = await mintInvite(db, { expiresInDays: -1 });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: invite.code,
        email: "late@example.test",
        password: "a-perfectly-fine-password",
        displayName: "Late",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });

    expect(response.statusCode).toBe(422);
  });

  it("refuses a code that was never minted", async () => {
    const { app } = ctx();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: "AAAABBBBCCCCDDDD",
        email: "nobody@example.test",
        password: "a-perfectly-fine-password",
        displayName: "Nobody",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe("sessions", () => {
  it("do not survive their user being deleted", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const before = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: user.cookie },
    });
    expect(before.statusCode).toBe(200);

    await db.delete(users).where(eq(users.id, user.userId));

    const after = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: user.cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});
