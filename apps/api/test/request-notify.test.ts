import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { outboundEmail, profiles, users } from "../src/db/schema.js";
import { requestInvite } from "../src/services/invite-request.service.js";

/**
 * The admin hears about a request (D129).
 *
 * The receipt the asker gets promises that a person will read the request.
 * Nothing made that person aware of it: the row went into a list nobody has a
 * reason to open, which is how somebody who asked politely waits three weeks
 * for an answer that was one click away.
 */

const ctx = useTestApp({
  REQUEST_ENABLED: true,
  PUBLIC_BASE_URL: "https://vikt.example.test",
});

async function makeAdmin(mail = true) {
  const { app, db } = ctx();
  const user = await createUser(app, db);
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
  if (!mail) {
    await db.update(profiles).set({ requestMail: false }).where(eq(profiles.userId, user.userId));
  }
  return user;
}

describe("when somebody asks for a code", () => {
  /**
   * Through the service rather than the route.
   *
   * The route's own job is the human check, which refuses an unsolved
   * challenge and is covered by `human-check.test.ts`. Driving it from here
   * would mean solving a proof of work in every one of these, to test
   * something the challenge has nothing to do with.
   */
  async function request(reason: string | null = null) {
    const { db, app } = ctx();
    return requestInvite(db, app.config, "hopeful@example.test", "Hoppfull", reason);
  }

  it("mails every admin who has not turned it off", async () => {
    const { db } = ctx();
    const wants = await makeAdmin(true);
    const doesNot = await makeAdmin(false);

    await request();

    const queued = await db.select().from(outboundEmail);
    const toAdmin = queued.filter((row) => row.template === "invite_request_admin");

    expect(toAdmin.map((row) => row.toAddress)).toContain(wants.email);
    expect(toAdmin.map((row) => row.toAddress)).not.toContain(doesNot.email);
  });

  /** The asker's own receipt is unaffected, and still goes out. */
  it("still sends the receipt to the person who asked", async () => {
    const { db } = ctx();
    await makeAdmin();
    await request();

    const queued = await db.select().from(outboundEmail);
    expect(queued.map((row) => row.template)).toContain("invite_requested");
  });

  /**
   * Actionable in one read: who asked, what they said, and where to answer.
   * A mail that says "somebody asked" only moves the reading somewhere else.
   */
  it("quotes the request and links to the admin screen", async () => {
    const { db } = ctx();
    await makeAdmin();
    await request("Jag vill sluta väga mig varje morgon.");

    const [mail] = await db
      .select()
      .from(outboundEmail)
      .where(eq(outboundEmail.template, "invite_request_admin"));

    expect(mail!.bodyText).toContain("Hoppfull");
    expect(mail!.bodyText).toContain("hopeful@example.test");
    expect(mail!.bodyText).toContain("Jag vill sluta väga mig varje morgon.");
    expect(mail!.bodyText).toContain("https://vikt.example.test/app/admin");
    // And it says how to stop receiving them, which is what makes it an opt-out.
    expect(mail!.bodyText).toContain("Inställningar");
  });

  /** A disabled account is not an admin who should be mailed anything. */
  it("skips a disabled admin", async () => {
    const { db } = ctx();
    const disabled = await makeAdmin();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.userId));

    await request();

    const queued = await db.select().from(outboundEmail);
    expect(queued.map((row) => row.toAddress)).not.toContain(disabled.email);
  });

  /**
   * A second request from the same address is one request, and produces no
   * second notification. The row is what makes it idempotent, and the mail
   * hangs off the row having been inserted.
   */
  it("does not mail twice for a repeat", async () => {
    const { db } = ctx();
    await makeAdmin();

    await request();
    await request();

    const queued = await db
      .select()
      .from(outboundEmail)
      .where(eq(outboundEmail.template, "invite_request_admin"));

    expect(queued).toHaveLength(1);
  });

  /**
   * An installation with no `PUBLIC_BASE_URL` cannot build the link, and that
   * is a reason to skip the notification rather than a reason to refuse a
   * stranger's request. The row is stored either way, and the marker on the
   * admin entry still appears, because it is counted from the rows.
   */
  it("still records the request when the link cannot be built", async () => {
    const { app, db } = ctx();
    await makeAdmin();

    const outcome = await requestInvite(
      db,
      { ...app.config, PUBLIC_BASE_URL: "", PUBLIC_ORIGIN: "" },
      "nobase@example.test",
      "Utan bas",
      null,
    );

    expect(outcome).toBe("queued");

    const queued = await db.select().from(outboundEmail);
    expect(queued.map((row) => row.template)).toContain("invite_requested");
    expect(queued.map((row) => row.template)).not.toContain("invite_request_admin");
  });
});

describe("the marker on the admin entry", () => {
  it("counts what is waiting, for an admin", async () => {
    const { app, db } = ctx();
    const admin = await makeAdmin();

    await requestInvite(db, app.config, "one@example.test", "En", null);
    await requestInvite(db, app.config, "two@example.test", "Två", null);

    const me = (
      await app.inject({ method: "GET", url: "/api/me", headers: auth(admin) })
    ).json() as { pendingRequests: number };

    expect(me.pendingRequests).toBe(2);
  });

  /**
   * Zero for everybody else, always. It is not a permission check — the count
   * is simply not information a non-admin has any use for, and asking for it
   * on every `/me` would be work done to produce a constant.
   */
  it("is zero for a normal account, even with requests waiting", async () => {
    const { app, db } = ctx();
    const plain = await createUser(app, db);
    await requestInvite(db, app.config, "one@example.test", "En", null);

    const me = (
      await app.inject({ method: "GET", url: "/api/me", headers: auth(plain) })
    ).json() as { pendingRequests: number };

    expect(me.pendingRequests).toBe(0);
  });
});

describe("the opt-out", () => {
  it("is on by default and can be turned off from the profile", async () => {
    const { app } = ctx();
    const admin = await makeAdmin();

    const before = (
      await app.inject({ method: "GET", url: "/api/me", headers: auth(admin) })
    ).json() as { profile: { requestMail: boolean } };
    expect(before.profile.requestMail).toBe(true);

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(admin),
      payload: { requestMail: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { profile: { requestMail: boolean } }).profile.requestMail).toBe(
      false,
    );
  });
});
