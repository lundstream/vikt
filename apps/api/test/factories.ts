import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { mintInvite } from "../src/services/invite.service.js";
import { sessionCookieFrom } from "./harness.js";

/**
 * Test data builders. Everything goes through the real HTTP surface where it
 * can, so the tests exercise the routes rather than a parallel setup path that
 * might not agree with them.
 */

export type TestUser = {
  userId: string;
  email: string;
  password: string;
  cookie: string;
};

let counter = 0;

/** Registers a user through `POST /api/auth/register` and returns their cookie. */
export async function createUser(
  app: FastifyInstance,
  db: Db,
  overrides: { email?: string; password?: string; heightCm?: number | null } = {},
): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `user${counter}-${randomUUID().slice(0, 8)}@example.test`;
  const password = overrides.password ?? "a-perfectly-fine-password";

  const invite = await mintInvite(db, {});

  const response = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: {
      inviteCode: invite.code,
      email,
      password,
      displayName: `User ${counter}`,
      timezone: "Europe/Stockholm",
      // Registration requires it explicitly (D107), so the factory says yes the
      // same way the form does rather than the schema being bypassed in tests.
      consent: true,
    },
  });

  if (response.statusCode !== 201) {
    throw new Error(`register failed (${response.statusCode}): ${response.body}`);
  }

  const user = {
    userId: response.json<{ id: string }>().id,
    email,
    password,
    cookie: sessionCookieFrom(response),
  };

  /**
   * Height, which registration stopped asking for (D105).
   *
   * Set here rather than left null because almost every test wants an account
   * whose BMI, waist-to-height and formula maintenance are computable, and
   * making each of them say so would be noise. A test that wants the empty
   * state passes `heightCm: null` and gets an account exactly as a real new
   * user has one.
   */
  if (overrides.heightCm !== null) {
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: { cookie: user.cookie },
      payload: { heightCm: overrides.heightCm ?? 180 },
    });
    if (patched.statusCode !== 200) {
      throw new Error(`setting height failed (${patched.statusCode}): ${patched.body}`);
    }
  }

  return user;
}

/** `{ cookie }` headers for an authenticated inject call. */
export function auth(user: TestUser): Record<string, string> {
  return { cookie: user.cookie };
}

/** An ISO date `offset` days before today, in the client's local terms. */
export function localDate(offset = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * Logs a single weight reading. A plan cannot be saved without one (D28), so
 * most plan tests need this first.
 */
export async function logWeight(
  app: FastifyInstance,
  user: TestUser,
  weightKg: number,
  offset = 0,
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/weight",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(offset), weightKg },
  });
  if (response.statusCode !== 200) {
    throw new Error(`logWeight failed (${response.statusCode}): ${response.body}`);
  }
}
