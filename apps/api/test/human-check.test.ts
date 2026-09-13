import { beforeEach, describe, expect, it } from "vitest";
import { solveChallenge } from "altcha-lib/v1";
import type { FastifyInstance } from "fastify";
import { inviteRequests } from "../src/db/schema.js";
import { useTestApp } from "./harness.js";
import { resetRateLimiters } from "../src/routes/public.routes.js";

/**
 * The human check on the invite form (D112).
 *
 * ALTCHA, self-hosted: a proof-of-work challenge this server issues and this
 * server verifies. The reason for choosing it over a hosted CAPTCHA is a
 * promise made two links away on /integritet, that nothing about a visitor
 * leaves this server, so the tests worth having are the ones that would catch
 * the check quietly becoming decorative.
 *
 * Every case here solves a real challenge rather than stubbing the solver out.
 * A mock proves the route calls something; this proves the browser's half and
 * the server's half agree about the payload, which is the part that actually
 * breaks.
 */

beforeEach(() => resetRateLimiters());

type Issued = {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
};

async function issue(app: FastifyInstance): Promise<Issued> {
  const response = await app.inject({
    method: "GET",
    url: "/api/invite-requests/challenge",
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Issued;
}

/** What the landing page's `solveHumanCheck` builds, in the same shape. */
async function solve(issued: Issued): Promise<string> {
  const solution = await solveChallenge(
    issued.challenge,
    issued.salt,
    issued.algorithm,
    issued.maxnumber,
  ).promise;
  expect(solution).not.toBeNull();

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

async function post(app: FastifyInstance, altcha: string, email = "hopeful@example.test") {
  return app.inject({
    method: "POST",
    url: "/api/invite-requests",
    payload: { name: "Hopeful", email, altcha },
  });
}

describe("the invite form's human check", () => {
  const ctx = useTestApp({ REQUEST_ENABLED: true });

  it("issues a challenge a browser can actually solve", async () => {
    const { app } = ctx();
    const issued = await issue(app);

    expect(issued.algorithm).toBe("SHA-256");
    expect(issued.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.signature.length).toBeGreaterThan(0);
    expect(issued.maxnumber).toBeGreaterThan(0);

    // Two challenges are never the same, or one solution would serve forever.
    const second = await issue(app);
    expect(second.challenge).not.toBe(issued.challenge);
  });

  it("accepts a solved challenge and stores the request", async () => {
    const { app, db } = ctx();

    const response = await post(app, await solve(await issue(app)));

    expect(response.statusCode).toBe(200);
    const [row] = await db.select().from(inviteRequests);
    expect(row).toMatchObject({ name: "Hopeful", email: "hopeful@example.test" });
  });

  /**
   * The case the whole thing exists for: a script that posts the form without
   * running any JavaScript.
   */
  it("refuses a submission with no solution at all", async () => {
    const { app, db } = ctx();

    const response = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: { name: "Bot", email: "bot@example.test" },
    });

    expect(response.statusCode).toBe(400);
    expect(await db.select().from(inviteRequests)).toEqual([]);
  });

  it("refuses a made-up payload", async () => {
    const { app, db } = ctx();

    const invented = Buffer.from(
      JSON.stringify({
        algorithm: "SHA-256",
        challenge: "0".repeat(64),
        number: 1,
        salt: "deadbeef",
        signature: "0".repeat(64),
        took: 1,
      }),
    ).toString("base64");

    expect((await post(app, invented)).statusCode).toBe(400);
    expect((await post(app, "not-base64-at-all")).statusCode).toBe(400);
    expect(await db.select().from(inviteRequests)).toEqual([]);
  });

  /**
   * A wrong answer to a genuine challenge.
   *
   * This is the one that separates a real check from a signature check: the
   * challenge and its signature are this server's own, so everything except the
   * proof of work verifies. If the number stopped being checked, only this
   * would notice.
   */
  it("refuses the right challenge with the wrong number", async () => {
    const { app, db } = ctx();
    const issued = await issue(app);

    const wrong = Buffer.from(
      JSON.stringify({
        algorithm: issued.algorithm,
        challenge: issued.challenge,
        number: issued.maxnumber + 1,
        salt: issued.salt,
        signature: issued.signature,
        took: 1,
      }),
    ).toString("base64");

    expect((await post(app, wrong)).statusCode).toBe(400);
    expect(await db.select().from(inviteRequests)).toEqual([]);
  });

  /**
   * One solution, one submission.
   *
   * A signature check alone would let a caller solve once and then post freely
   * for the two minutes the challenge lives, which is exactly the volume the
   * check is there to make expensive.
   */
  it("will not take the same solution twice", async () => {
    const { app, db } = ctx();
    const solved = await solve(await issue(app));

    expect((await post(app, solved, "first@example.test")).statusCode).toBe(200);
    expect((await post(app, solved, "second@example.test")).statusCode).toBe(400);

    const rows = await db.select().from(inviteRequests);
    expect(rows.map((row) => row.email)).toEqual(["first@example.test"]);
  });

  /**
   * The three guards stack (D112), and the honeypot still wins.
   *
   * A bot that solves the challenge and also fills the hidden field is still a
   * bot, and it still gets the same 200 as everyone else so it learns nothing.
   */
  it("still swallows a honeypot hit, solved or not", async () => {
    const { app, db } = ctx();

    const response = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: {
        name: "Bot",
        email: "bot@example.test",
        website: "http://spam.example",
        altcha: await solve(await issue(app)),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(await db.select().from(inviteRequests)).toEqual([]);
  });

  /** And a name is required: the owner reads these by hand. */
  it("requires a name", async () => {
    const { app } = ctx();

    const response = await app.inject({
      method: "POST",
      url: "/api/invite-requests",
      payload: { email: "hopeful@example.test", altcha: await solve(await issue(app)) },
    });

    expect(response.statusCode).toBe(400);
  });
});
