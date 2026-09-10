import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "shared";
import {
  INVITE_CHALLENGE_PER_IP,
  INVITE_REQUEST_PER_IP,
  RESET_PER_ADDRESS,
  RESET_PER_IP,
  RateLimiter,
} from "../lib/rate-limit.js";
import { completeReset, requestReset } from "../services/reset.service.js";
import { requestInvite } from "../services/invite-request.service.js";
import { tooManyRequests } from "../lib/errors.js";
import { checkSolution, issueChallenge, resetSpentChallenges } from "../lib/altcha.js";

/**
 * The two public, unauthenticated endpoints (D88, D89).
 *
 * The only surfaces where an anonymous caller can make this server do work or
 * send mail, which is why both are rate limited on `request.clientIp` — the
 * D14 path, which validates the peer before believing any forwarding header —
 * and why the invite form carries a honeypot.
 *
 * Both answer **identically regardless of what they found**. The reset endpoint
 * does not disclose whether an address has an account, and the invite endpoint
 * does not disclose whether one has already asked. For a weight-tracking app an
 * account-existence oracle is a more sensitive disclosure than it would be for
 * most, and the property is cheap: say the same thing, and do the same amount
 * of work saying it.
 */

/** Module-scope so the counters survive between requests, per instance. */
const resetByIp = new RateLimiter(RESET_PER_IP.limit, RESET_PER_IP.windowMs);
const resetByAddress = new RateLimiter(RESET_PER_ADDRESS.limit, RESET_PER_ADDRESS.windowMs);
const inviteByIp = new RateLimiter(
  INVITE_REQUEST_PER_IP.limit,
  INVITE_REQUEST_PER_IP.windowMs,
);
const challengeByIp = new RateLimiter(
  INVITE_CHALLENGE_PER_IP.limit,
  INVITE_CHALLENGE_PER_IP.windowMs,
);

/** Tests only: counters are process-wide and would leak between cases. */
export function resetRateLimiters(): void {
  resetByIp.reset();
  resetByAddress.reset();
  inviteByIp.reset();
  challengeByIp.reset();
  resetSpentChallenges();
}

const acceptedSchema = z.object({ accepted: z.literal(true) });

export const publicRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * The invite endpoint exists only where requests are accepted (D94, D127).
   *
   * Not registered rather than registered-and-refusing: an endpoint that
   * answers 403 is still an endpoint, still reachable, still something to
   * rate-limit and reason about. An installation that does not take requests
   * should not have a public write path at all, and the cleanest way to say
   * that is for the route not to be there.
   *
   * It used to hang off `LANDING_ENABLED`. It hangs off `REQUEST_ENABLED` now,
   * because serving a page to read and accepting a stranger's name and address
   * are different decisions with different consequences (D127).
   *
   * Password reset is not gated: it is for people who already have accounts,
   * and it degrades on its own when mail is unconfigured.
   */
  const requests = app.config.REQUEST_ENABLED;

  /**
   * "Send me a reset link."
   *
   * Always 200 with the same body. The rate limit is the one thing that can
   * refuse, and it refuses on volume rather than on anything about the address.
   */
  app.post(
    "/auth/reset/request",
    {
      schema: {
        body: z.object({ email: z.string().trim().email().max(200) }),
        response: { 200: acceptedSchema, 429: errorResponseSchema },
      },
    },
    async (request) => {
      const address = request.body.email.trim().toLowerCase();

      const byIp = resetByIp.check(request.clientIp);
      if (!byIp.allowed) throw tooManyRequests(byIp.retryAfterSeconds);

      /**
       * Per address as well as per IP, because they stop different things. Per
       * IP stops one machine hammering the endpoint; per address stops a
       * distributed caller using somebody else's inbox as a mailbomb target,
       * which no per-IP limit can see.
       */
      const byAddress = resetByAddress.check(address);
      if (!byAddress.allowed) throw tooManyRequests(byAddress.retryAfterSeconds);

      await requestReset(app.db, app.config, address);
      return { accepted: true as const };
    },
  );

  /** Spending a token. One outcome for every way of being wrong. */
  app.post(
    "/auth/reset/complete",
    {
      schema: {
        body: z.object({
          token: z.string().trim().min(16).max(200),
          password: z.string().min(10).max(200),
        }),
        response: {
          200: acceptedSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const outcome = await completeReset(
        app.db,
        request.body.token,
        request.body.password,
      );

      if (!outcome.ok) {
        return reply.code(400).send({
          error: "invalid_or_expired",
          message: "Länken gäller inte längre. Begär en ny.",
        });
      }

      // Every session for that user is gone, including any this browser held.
      app.clearSessionCookie(reply);
      return { accepted: true as const };
    },
  );

  /**
   * "May I have an invite code?"
   *
   * Stores an address, an optional line, and a timestamp. Nothing else about
   * the requester is recorded, which is what the landing page's privacy text
   * promises.
   */
  /**
   * A proof-of-work challenge for the form below (D112).
   *
   * Unauthenticated and cheap on purpose: issuing costs a random salt and an
   * HMAC, while solving costs the caller tens of thousands of hashes, so the
   * work is on the side asking for something. Limited on its own counter, so
   * one honest attempt does not spend two of the five submissions an hour.
   */
  if (requests) app.get(
    "/invite-requests/challenge",
    {
      schema: {
        response: {
          200: z.object({
            algorithm: z.string(),
            challenge: z.string(),
            salt: z.string(),
            signature: z.string(),
            maxnumber: z.number(),
          }),
          429: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const byIp = challengeByIp.check(request.clientIp);
      if (!byIp.allowed) throw tooManyRequests(byIp.retryAfterSeconds);
      return issueChallenge();
    },
  );

  if (requests) app.post(
    "/invite-requests",
    {
      schema: {
        body: z.object({
          email: z.string().trim().email().max(200),
          /**
           * Who is asking. Required, because the owner reads these by hand and
           * an address alone is not much to decide on, and free text, because
           * a name is whatever the person says it is.
           */
          name: z.string().trim().min(1).max(120),
          reason: z.string().trim().max(500).optional(),
          /**
           * The honeypot. A real person never sees this field and never fills
           * it; a bot that fills every input does. Named plausibly rather than
           * `honeypot`, and the request is accepted rather than refused, so a
           * scraper learns nothing from the response about having been caught.
           */
          website: z.string().max(200).optional(),
          /** The solved ALTCHA challenge, base64 JSON (D112). */
          altcha: z.string().min(1).max(2000),
        }),
        response: {
          200: acceptedSchema,
          400: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const byIp = inviteByIp.check(request.clientIp);
      if (!byIp.allowed) throw tooManyRequests(byIp.retryAfterSeconds);

      if ((request.body.website ?? "").trim() !== "") {
        app.log.info({ ip: request.clientIp }, "invite request tripped the honeypot");
        return { accepted: true as const };
      }

      /**
       * The human check, and the one place this endpoint refuses out loud.
       *
       * The honeypot lies, because telling a scraper it was caught teaches it
       * how not to be. This does not, because a person whose challenge expired
       * while they were writing needs to know to press the button again, and
       * "silently did nothing" is the worst possible answer for them. The two
       * are different failures and get different treatment on purpose.
       */
      const solution = await checkSolution(request.body.altcha);
      if (solution !== "ok") {
        app.log.info({ ip: request.clientIp, solution }, "invite request failed the human check");
        return reply.code(400).send({
          error: "human_check_failed",
          message: "Kontrollen gick ut. Försök igen.",
        });
      }

      await requestInvite(
        app.db,
        request.body.email,
        request.body.name.trim(),
        request.body.reason?.trim() || null,
      );
      return { accepted: true as const };
    },
  );
};
