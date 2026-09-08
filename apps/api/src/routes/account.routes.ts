import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { errorResponseSchema } from "shared";
import {
  acceptTerms,
  deleteOwnAccount,
  previewOwnDeletion,
} from "../services/account.service.js";

/**
 * The two things a user may do to their own account (D107).
 *
 * Both are behind `requireAuth` and scoped to `request.userId`, which is the
 * only source of scope: there is no id in any path here, so there is nothing to
 * confuse with somebody else's account.
 */

const previewSchema = z.object({
  email: z.string(),
  weights: z.number().int(),
  foodEntries: z.number().int(),
  dailyLogs: z.number().int(),
  photos: z.number().int(),
});

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Agreeing to the privacy text, for an account created before it was asked. */
  app.post(
    "/me/consent",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ consentedAt: z.string() }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({ consentedAt: await acceptTerms(request.userId!, app.db) }),
  );

  /**
   * What leaving would remove.
   *
   * The same counts an admin sees before deleting somebody (D95), for the same
   * reason: "delete account" is an abstraction and "84 vägningar, 113 matrader"
   * is the thing that is about to happen.
   */
  app.get(
    "/me/deletion",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: previewSchema, 401: errorResponseSchema, 404: errorResponseSchema } },
    },
    async (request, reply) => {
      const preview = await previewOwnDeletion(request.userId!, app.db);
      if (!preview) return reply.code(404).send({ error: "not_found", message: "No account." });
      return preview;
    },
  );

  /**
   * Leaving.
   *
   * The password is required and the session cookie is not enough. A cookie is
   * enough to read and write; it is not enough to destroy, because a borrowed
   * phone or a session left open on a shared machine should not be able to
   * erase a year of somebody's logging in one tap.
   */
  app.post(
    "/me/delete",
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({ password: z.string().min(1).max(512) }),
        response: {
          200: z.object({ ok: z.literal(true), removed: previewSchema }),
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const outcome = await deleteOwnAccount(
        request.userId!,
        app.db,
        request.body.password,
        /**
         * No photo storage to clear yet: Phase 7 has not shipped, and
         * `previewDeletion` reports zero photos for every account. The
         * parameter exists so the file that adds photos has one obvious place
         * to hook into rather than a delete path to remember (D10).
         */
        async () => {},
      );

      if (!outcome.ok) {
        return outcome.reason === "wrong_password"
          ? reply.code(403).send({
              error: "wrong_password",
              message: "Lösenordet stämmer inte.",
            })
          : reply.code(404).send({ error: "not_found", message: "No account." });
      }

      // The session rows cascaded with the account, so the cookie now names a
      // session that does not exist. Cleared through the decorator, so the path
      // and flags match the ones it was set with.
      app.clearSessionCookie(reply);
      return { ok: true as const, removed: outcome.removed };
    },
  );
};
