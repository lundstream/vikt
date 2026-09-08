import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inviteRequests, outboundEmail, users } from "../src/db/schema.js";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { resetRateLimiters } from "../src/routes/public.routes.js";
import { solveChallenge } from "altcha-lib/v1";
import type { FastifyInstance } from "fastify";

/**
 * Asking for a code, and the admin deciding (D89).
 *
 * The public half is the same class of surface as the reset request: anonymous,
 * capable of causing mail, and therefore rate limited on the D14 client address
 * and deliberately uninformative about what it found.
 */

beforeEach(() => resetRateLimiters());

/**
 * A genuinely solved challenge from this server (D112).
 *
 * The test does the work a browser does rather than stubbing the check out,
 * which is the only version that proves the two halves agree: a solver that
 * built the payload the wrong way, or a verifier that accepted the wrong
 * shape, would both pass a mock and fail here.
 */
async function humanCheck(app: FastifyInstance): Promise<string> {
  const issued = (
    await app.inject({ method: "GET", url: "/api/invite-requests/challenge" })
  ).json() as {
    algorithm: string;
    challenge: string;
    salt: string;
    signature: string;
    maxnumber: number;
  };

  const solution = await solveChallenge(
    issued.challenge,
    issued.salt,
    issued.algorithm,
    issued.maxnumber,
  ).promise;

  expect(solution, "the challenge was not solvable").not.toBeNull();

  return Buffer.from(
    JSON.stringify({
      algorithm: issued.algorithm,
      challenge: issued.challenge,
      number: solution!.number,
      salt: issued.salt,
      signature: issued.signature,
      took: solution!.took,
    }),
  ).toString("base64");
}


async function makeAdmin(db: Awaited<ReturnType<ReturnType<typeof useTestApp>>>["db"], userId: string) {
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
}

describe("requesting an invite", () => {
  // The endpoint only exists where the landing page does (D94).
  const ctx = useTestApp({ LANDING_ENABLED: true });

  it("stores the address and queues a receipt", async () => {
    const { app, db } = ctx();

    const response = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Hopeful",
        email: "hopeful@example.test",
        reason: "Vill logga vikt.",
        altcha: await humanCheck(app),
      },
    });

    expect(response.statusCode).toBe(200);

    const [row] = await db.select().from(inviteRequests);
    expect(row).toMatchObject({
      name: "Hopeful",
      email: "hopeful@example.test",
      reason: "Vill logga vikt.",
      status: "pending",
    });

    const [mail] = await db.select().from(outboundEmail);
    expect(mail!.template).toBe("invite_requested");
    expect(mail!.status).toBe("pending");
  });

  /** Asking twice is one request, and the caller cannot tell which it was. */
  it("answers the same for a repeat, and stores one row", async () => {
    const { app, db } = ctx();
    const base = { name: "Hopeful", email: "hopeful@example.test" };

    // A fresh challenge each time: one solution cannot be spent twice.
    const first = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: { ...base, altcha: await humanCheck(app) },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: { ...base, altcha: await humanCheck(app) },
    });

    expect(first.statusCode).toBe(second.statusCode);
    expect(first.json()).toEqual(second.json());
    expect(await db.select().from(inviteRequests)).toHaveLength(1);
    // And no second receipt: one request, one mail.
    expect(await db.select().from(outboundEmail)).toHaveLength(1);
  });

  /**
   * The honeypot is accepted rather than refused, so a scraper learns nothing
   * from the response about having been caught.
   */
  it("swallows a request that filled the honeypot", async () => {
    const { app, db } = ctx();

    const response = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Bot",
        email: "bot@example.test",
        website: "http://spam.example",
        altcha: await humanCheck(app),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(inviteRequests)).toEqual([]);
    expect(await db.select().from(outboundEmail)).toEqual([]);
  });

  it("caps what it will store", async () => {
    const { app } = ctx();

    const response = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Hopeful",
        email: "hopeful@example.test",
        reason: "x".repeat(2000),
        altcha: await humanCheck(app),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("rate limits per address of the caller, not per address requested", async () => {
    const { app } = ctx();

    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/invite-requests",
        payload: {
          name: "Hopeful",
          email: `hopeful${i}@example.test`,
          altcha: await humanCheck(app),
        },
      });
      codes.push(response.statusCode);
    }

    // Five per IP per hour: different addresses do not buy more attempts.
    expect(codes.filter((code) => code === 200)).toHaveLength(5);
    expect(codes.at(-1)).toBe(429);
  });
});

describe("the admin view", () => {
  const ctx = useTestApp({ LANDING_ENABLED: true });

  /** A non-admin gets 404, not 403: these endpoints are not theirs to know about. */
  it("is invisible to an ordinary account", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const url of ["/api/admin/invite-requests", "/api/admin/mail"]) {
      const response = await app.inject({ method: "GET", url, headers: auth(user) });
      expect(response.statusCode).toBe(404);
    }
  });

  it("is closed to an anonymous caller", async () => {
    const { app } = ctx();
    const response = await app.inject({ method: "GET", url: "/api/admin/invite-requests" });
    expect(response.statusCode).toBe(401);
  });

  it("lists what is waiting", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Hopeful",
        email: "hopeful@example.test",
        altcha: await humanCheck(app),
      },
    });

    const body = (
      await app.inject({
        method: "GET",
        url: "/api/admin/invite-requests",
        headers: auth(admin),
      })
    ).json();

    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].email).toBe("hopeful@example.test");
    // Mail is off in tests, so the screen knows to show the code instead.
    expect(body.mailEnabled).toBe(false);
  });

  /**
   * Approving with mail off is the degraded path (D88): the code comes back on
   * screen for the owner to pass on by hand, and nothing is lost.
   */
  it("approving mints a code and says whether it could send it", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Hopeful",
        email: "hopeful@example.test",
        altcha: await humanCheck(app),
      },
    });
    const [request] = await db.select().from(inviteRequests);

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/invite-requests/${request!.id}/approve`,
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().code).toMatch(/\S/);
    expect(response.json().emailed).toBe(false);

    // The code is kept on the row, so the screen can show it again.
    const [after] = await db.select().from(inviteRequests);
    expect(after!.status).toBe("approved");
    expect(after!.inviteCode).toBe(response.json().code);
  });

  it("mints a code that actually registers an account", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Hopeful",
        email: "hopeful@example.test",
        altcha: await humanCheck(app),
      },
    });
    const [request] = await db.select().from(inviteRequests);
    const { code } = (
      await app.inject({
        method: "POST",
        url: `/api/admin/invite-requests/${request!.id}/approve`,
        headers: auth(admin),
      })
    ).json();

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        inviteCode: code,
        email: "hopeful@example.test",
        password: "a-perfectly-fine-password",
        displayName: "Hopeful",
        consent: true as const,
        timezone: "Europe/Stockholm",
        heightCm: 180,
      },
    });

    expect(registered.statusCode).toBe(201);
  });

  /** Rejecting deletes the row and sends nothing at all. */
  it("rejecting leaves no trace and no mail", async () => {
    const { app, db } = ctx();
    const admin = await createUser(app, db);
    await makeAdmin(db, admin.userId);

    await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Hopeful",
        email: "hopeful@example.test",
        altcha: await humanCheck(app),
      },
    });
    const [request] = await db.select().from(inviteRequests);
    const before = (await db.select().from(outboundEmail)).length;

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/invite-requests/${request!.id}/reject`,
      headers: auth(admin),
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(inviteRequests)).toEqual([]);
    // No rejection notice: unasked-for mail from an address nobody can reply to.
    expect(await db.select().from(outboundEmail)).toHaveLength(before);
  });
});

/**
 * The mode itself (D94).
 *
 * Not registered rather than registered-and-refusing: a private install should
 * not have a public write path at all, and 404 is what "there is no such
 * endpoint here" looks like from outside.
 */
describe("with the landing mode off", () => {
  const ctx = useTestApp({ LANDING_ENABLED: false });

  it("has no invite-request endpoint at all, and no challenge either", async () => {
    const { app } = ctx();

    const posted = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: { name: "Hopeful", email: "hopeful@example.test", altcha: "irrelevant" },
    });
    expect(posted.statusCode).toBe(404);

    // The human check is part of that surface and goes with it (D112). A
    // challenge endpoint left behind would be a public route on an install
    // that is supposed to have none.
    const challenge = await app.inject({
      method: "GET",
      url: "/api/invite-requests/challenge",
    });
    expect(challenge.statusCode).toBe(404);
  });

  it("still lets an existing account reset its password", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // Reset is for people who already have accounts, so it is not gated on
    // the landing mode; it degrades on its own when mail is unconfigured.
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/reset/request",
      payload: { email: user.email },
    });

    expect(response.statusCode).toBe(200);
  });
});
