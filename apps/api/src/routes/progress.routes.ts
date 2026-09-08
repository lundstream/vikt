import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  asOfQuerySchema,
  createMilestoneSchema,
  createOffsetSchema,
  createSavingsEventSchema,
  createSavingsRuleSchema,
  previewSavingsRuleSchema,
  savingsRulePreviewSchema,
  errorResponseSchema,
  milestoneSchema,
  potSchema,
  progressResponseSchema,
  savingsEventSchema,
  savingsRuleSchema,
  updateMilestoneSchema,
  updateSavingsRuleSchema,
} from "shared";
import {
  acknowledgeCelebration,
  claimReward,
  createMilestone,
  createSavingsEvent,
  createSavingsRule,
  previewSavingsRule,
  removeSavingsRule,
  editMilestone,
  editSavingsRule,
  getPot,
  getProgress,
  removeMilestone,
  removeOffset,
  removeSavingsEvent,
  saveOffset,
} from "../services/progress.service.js";

/**
 * Milestones, rewards and the savings pot.
 *
 * `userId` comes from `request.userId`, set by `requireAuth`, never from the
 * body or the query string.
 *
 * `asOf` is the client's local date and the server never derives one (§3): the
 * pot accrues by calendar day, so a UTC-derived "today" would add a day's
 * savings shortly before midnight in Stockholm and take it away again.
 */

const today = () => new Date().toISOString().slice(0, 10);

export const progressRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Everything the progress screen needs, in one request. */
  app.get(
    "/progress",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: asOfQuerySchema,
        response: { 200: progressResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => getProgress(request.userId!, app.db, request.query.asOf ?? today()),
  );

  app.get(
    "/pot",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: asOfQuerySchema,
        response: { 200: potSchema, 401: errorResponseSchema },
      },
    },
    async (request) => getPot(request.userId!, app.db, request.query.asOf ?? today()),
  );

  /* ----------------------------------------------------------- milestones */

  app.post(
    "/milestones",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createMilestoneSchema,
        response: {
          201: z.object({ id: z.string().uuid() }),
          401: errorResponseSchema,
          // The same metric and target already exists (D49).
          409: errorResponseSchema,
          // The target is outside the metric's plausible band.
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const row = await createMilestone(request.userId!, app.db, request.body);
      return reply.code(201).send({ id: row.id });
    },
  );

  app.patch(
    "/milestones/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: updateMilestoneSchema,
        response: {
          200: z.object({ id: z.string().uuid() }),
          401: errorResponseSchema,
          404: errorResponseSchema,
          // An out-of-range target for the metric the row ends up with.
          422: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const row = await editMilestone(
        request.userId!,
        app.db,
        request.params.id,
        request.body,
      );
      return { id: row.id };
    },
  );

  app.delete(
    "/milestones/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeMilestone(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * Acknowledge the celebration, so it fires once and not on every dashboard
   * load (D38). Stamping an already-stamped milestone is a no-op rather than an
   * error: a double-tap or a replayed request is not a failure.
   */
  app.post(
    "/milestones/:id/celebrated",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await acknowledgeCelebration(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /** Cash in a reward. The pot is allowed to go negative as a result. */
  app.post(
    "/milestones/:id/claim",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: asOfQuerySchema.optional(),
        response: {
          200: milestoneSchema.pick({ id: true, rewardClaimedAt: true }),
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const row = await claimReward(
        request.userId!,
        app.db,
        request.params.id,
        request.body?.asOf ?? today(),
      );
      return { id: row.id, rewardClaimedAt: row.rewardClaimedAt?.toISOString() ?? null };
    },
  );

  /* -------------------------------------------------------------- savings */

  app.post(
    "/savings/rules",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createSavingsRuleSchema,
        response: { 201: z.object({ id: z.string().uuid() }), 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const row = await createSavingsRule(request.userId!, app.db, request.body);
      return reply.code(201).send({ id: row.id });
    },
  );

  app.patch(
    "/savings/rules/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: updateSavingsRuleSchema,
        response: {
          200: savingsRuleSchema.pick({ id: true }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const row = await editSavingsRule(
        request.userId!,
        app.db,
        request.params.id,
        request.body,
      );
      return { id: row.id };
    },
  );

  /**
   * What a change would do to the pot, before it is made.
   *
   * A read modelled as a POST, because the proposed rule is a body rather than
   * something that belongs in a query string, and because it must never be
   * cached — the answer depends on today's date and on every other rule.
   *
   * `next: null` previews deleting the rule.
   */
  app.post(
    "/savings/rules/:id/preview",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: previewSavingsRuleSchema,
        response: {
          200: savingsRulePreviewSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      previewSavingsRule(request.userId!, app.db, request.params.id, request.body),
  );

  /**
   * Deleting a rule removes what it accrued, because §4.5 keeps no per-day
   * rows: the rule is the record. The consequence is shown by the preview above
   * before this is called.
   */
  app.delete(
    "/savings/rules/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeSavingsRule(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * "I did buy the lunch after all."
   *
   * Idempotent on `(rule_id, local_date)`, which is a natural key, so a replay
   * from the offline queue files one fact rather than two deductions.
   */
  app.post(
    "/savings/offsets",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createOffsetSchema,
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await saveOffset(request.userId!, app.db, request.body);
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/savings/offsets",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: z.object({
          ruleId: z.string().uuid(),
          localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeOffset(
        request.userId!,
        app.db,
        request.query.ruleId,
        request.query.localDate,
      );
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/savings/events",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createSavingsEventSchema,
        response: { 201: savingsEventSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const event = await createSavingsEvent(request.userId!, app.db, request.body);
      return reply.code(201).send(event);
    },
  );

  app.delete(
    "/savings/events/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeSavingsEvent(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );
};
