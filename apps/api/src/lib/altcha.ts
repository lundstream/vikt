import { hkdfSync, randomBytes } from "node:crypto";
import { createChallenge, verifySolution } from "altcha-lib/v1";
import { readSecretKey } from "./secrets.js";

/**
 * The human check on the invite form (D112).
 *
 * ## Why this one
 *
 * The landing page says nothing leaves the server, and /integritet lists every
 * party that sees anything. A reCAPTCHA or an hCaptcha would make that list
 * longer and would make it longer in the worst way: an advertising company
 * would be told the address of every visitor who asked for an account on a
 * weight-tracking app. Turnstile is better on that axis and still a third party
 * on the page.
 *
 * ALTCHA is proof of work. The server hands out a challenge, the browser
 * spends a fraction of a second finding the number that hashes to it, and the
 * server checks the answer against its own HMAC. Nothing is fetched from
 * anywhere, no cookie is set, and the visitor is never asked to identify a
 * traffic light. Nothing to click at all: the solving happens while the form is
 * being submitted.
 *
 * ## What it is and is not
 *
 * It is a cost, not an identity check. Someone determined to submit a thousand
 * requests can pay the CPU for a thousand requests. What it stops is the
 * cheapest and by far the commonest thing: a script that posts to every form it
 * finds, which will not run the JavaScript and cannot produce a signature.
 *
 * That is why it **stacks** rather than replaces. The honeypot catches the bot
 * that fills every field, the rate limit caps volume per address, and this
 * costs the caller something per attempt. Each of the three fails differently,
 * which is the argument for having all of them.
 *
 * ## The key
 *
 * Derived from `SECRET_KEY` through HKDF with its own `info` string, so this
 * shares no key material with the encrypted mail settings and adds nothing new
 * to configure.
 *
 * Where `SECRET_KEY` is unset — a dev machine, a test run — a random key is
 * generated for the process. Challenges then stop verifying across a restart,
 * which is correct: they live for two minutes and a restart is not a case worth
 * carrying state for.
 */

/** Two minutes. Long enough to fill in a form, short enough that a stolen challenge is stale. */
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

/**
 * How much work a solution costs.
 *
 * The client tries every number up to this one, so the expected cost is half of
 * it. Measured on this machine with the real solver: 133 ms at 10 000, 162 ms
 * at 20 000, 466 ms at 50 000. A phone is a few times slower than that, so
 * 20 000 keeps an honest attempt to roughly half a second inside a submit the
 * visitor has already pressed, and 50 000 would have made the slowest phones
 * wait a couple of seconds for nothing they can see.
 *
 * Raising it does not buy much anyway: an attacker's cost and a visitor's cost
 * rise together, and the visitor is the one with the slower device. The cap on
 * volume is the rate limit, not this.
 */
const MAX_NUMBER = 20_000;

let processKey: string | null = null;

function hmacKey(env: NodeJS.ProcessEnv = process.env): string {
  const secret = readSecretKey(env);

  if (secret === null) {
    processKey ??= randomBytes(32).toString("hex");
    return processKey;
  }

  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("vikt.secrets.v1"), "altcha", 32),
  ).toString("hex");
}

/**
 * Challenges already spent, so one solution cannot be posted twice.
 *
 * `verifySolution` proves the challenge came from this server and has not
 * expired. It cannot know the answer has been used, and without this a single
 * solved payload would be worth two minutes of unlimited posting.
 *
 * In memory and per instance, like the rate limiters above it, and with the
 * same caveat: a second API replica has its own set. See the mail-queue
 * decision on why a single instance is the supported deployment.
 */
const spent = new Map<string, number>();

function forget(now: number): void {
  for (const [challenge, expiry] of spent) {
    if (expiry <= now) spent.delete(challenge);
  }
}

export type IssuedChallenge = {
  algorithm: string;
  challenge: string;
  salt: string;
  signature: string;
  maxnumber: number;
};

/** A fresh challenge for one form submission. */
export async function issueChallenge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IssuedChallenge> {
  const challenge = await createChallenge({
    hmacKey: hmacKey(env),
    maxnumber: MAX_NUMBER,
    expires: new Date(Date.now() + CHALLENGE_TTL_MS),
  });

  return {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    signature: challenge.signature,
    maxnumber: challenge.maxnumber ?? MAX_NUMBER,
  };
}

export type CheckResult = "ok" | "invalid" | "replayed";

/**
 * Checks a solved payload, and spends it.
 *
 * Three outcomes rather than a boolean, because the caller says something
 * different for a replay than for a forgery, and because a log line saying
 * which of the two happened is the difference between "someone is retrying" and
 * "someone is attacking".
 */
export async function checkSolution(
  payload: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckResult> {
  const now = Date.now();
  forget(now);

  let ok = false;
  try {
    ok = await verifySolution(payload, hmacKey(env));
  } catch {
    // A payload that is not base64, not JSON, or not the right shape. Same
    // answer as a wrong one: this is not a place to help a caller debug.
    return "invalid";
  }

  if (!ok) return "invalid";

  /**
   * Keyed on the challenge hash, which is unique per issued challenge and is
   * the part the signature covers. Keyed on the whole payload it would be
   * enough to change `took` to replay.
   */
  let challenge: string;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      challenge?: unknown;
    };
    if (typeof decoded.challenge !== "string") return "invalid";
    challenge = decoded.challenge;
  } catch {
    return "invalid";
  }

  if (spent.has(challenge)) return "replayed";

  spent.set(challenge, now + CHALLENGE_TTL_MS);
  return "ok";
}

/** Tests only: the spent set is process-wide and would leak between cases. */
export function resetSpentChallenges(): void {
  spent.clear();
}
