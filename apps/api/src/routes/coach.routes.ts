import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  coachAskSchema,
  coachConversationListSchema,
  coachConversationSchema,
  coachReviewListSchema,
  coachReviewSchema,
  errorResponseSchema,
} from "shared";
import {
  askCoach,
  dismissReview,
  getConversation,
  listConversations,
  listReviews,
  newestUndismissedReview,
  removeAllConversations,
  removeConversation,
} from "../services/coach.service.js";
import { generateWeeklyReview } from "../services/review.service.js";

/**
 * The coach (D139), §6 phase 8b.
 *
 * **Not registered at all when the LLM layer is off.** Same rule as push
 * (D136) and as every other unavailable feature (D94): the route does not
 * exist, the navigation entry is not drawn, and the stored history stays where
 * it is rather than being deleted by a configuration change. A 403 from a route
 * that exists is still a route that exists.
 *
 * The answer is **Server-Sent Events**, which is the one place in this API that
 * is not a JSON body. A conversation that takes eight seconds should start
 * arriving after one, and SSE is one HTTP response with no second protocol, no
 * socket to keep alive and nothing to reconnect: exactly the amount of
 * machinery this needs.
 */
export const coachRoutes: FastifyPluginAsyncZod = async (app) => {
  if (!app.llm.enabled) return;

  app.get(
    "/coach/conversations",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: coachConversationListSchema, 401: errorResponseSchema } },
    },
    async (request) => ({ conversations: await listConversations(request.userId!, app.db) }),
  );

  app.get(
    "/coach/conversations/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: coachConversationSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const conversation = await getConversation(request.userId!, app.db, request.params.id);
      if (conversation === null) {
        return reply.code(404).send({ error: "not_found", message: "Det samtalet finns inte." });
      }
      return conversation;
    },
  );

  /** One conversation, gone, with its messages (D9). */
  app.delete(
    "/coach/conversations/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const removed = await removeConversation(request.userId!, app.db, request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: "not_found", message: "Det samtalet finns inte." });
      }
      return reply.code(204).send(null);
    },
  );

  /** All of it. Offered beside the per-conversation delete, not instead of it. */
  app.delete(
    "/coach/conversations",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ removed: z.number().int().min(0) }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({ removed: await removeAllConversations(request.userId!, app.db) }),
  );

  /**
   * A turn, streamed.
   *
   * No response schema: this writes events to the raw socket rather than
   * handing Fastify a body to serialise. Every event is one JSON object on a
   * `data:` line, and the stream ends with `done`, `refused`, `busy`,
   * `unreachable` or `limited` — the client never has to guess why it stopped.
   */
  app.post(
    "/coach/ask",
    { preHandler: app.requireAuth, schema: { body: coachAskSchema } },
    async (request, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        // nginx buffers proxied responses by default, which would hold every
        // event until the last one and make a streamed answer arrive at once.
        "X-Accel-Buffering": "no",
      });

      const write = (event: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      try {
        for await (const event of askCoach(request.userId!, app.db, app.config, app.llm, {
          conversationId: request.body.conversationId ?? null,
          question: request.body.question,
          asOf: request.body.asOf,
        })) {
          write(event);
        }
      } catch (error) {
        request.log.error({ err: error }, "coach turn failed");
        write({ type: "unreachable" });
      } finally {
        reply.raw.end();
      }

      return reply;
    },
  );

  /* ----------------------------------------------------- the weekly review */

  app.get(
    "/coach/reviews",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: coachReviewListSchema, 401: errorResponseSchema } },
    },
    async (request) => ({ reviews: await listReviews(request.userId!, app.db) }),
  );

  /**
   * What the dashboard card shows, or null.
   *
   * Null rather than a 404, because "there is no new review" is the ordinary
   * state and not a missing resource. The card draws nothing for null, which is
   * how it manages to appear **once**.
   */
  app.get(
    "/coach/review/current",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ review: coachReviewSchema.nullable() }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({ review: await newestUndismissedReview(request.userId!, app.db) }),
  );

  /**
   * Writing the week's summary, when somebody asks for it.
   *
   * Idempotent per week: a second request in the same week answers with the
   * text that is already stored rather than a second opinion.
   */
  app.post(
    "/coach/reviews",
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
        response: {
          200: z.object({
            status: z.enum(["written", "exists", "unreachable", "refused"]),
            review: coachReviewSchema.nullable(),
          }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const outcome = await generateWeeklyReview(
        request.userId!,
        app.db,
        app.config,
        app.llm,
        request.body.asOf,
      );

      if (outcome.status === "unreachable" || outcome.status === "refused") {
        return { status: outcome.status, review: null };
      }

      const review = await newestUndismissedReview(request.userId!, app.db);
      return {
        status: outcome.status,
        review:
          review ??
          {
            id: outcome.id,
            weekStart: request.body.asOf,
            body: outcome.body,
            createdAt: new Date().toISOString(),
          },
      };
    },
  );

  /** Putting the card away, on the row rather than in the browser (D108). */
  app.post(
    "/coach/reviews/:id/dismiss",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const dismissed = await dismissReview(request.userId!, app.db, request.params.id);
      if (!dismissed) {
        return reply.code(404).send({ error: "not_found", message: "Ingen sådan sammanfattning." });
      }
      return { ok: true as const };
    },
  );
};
