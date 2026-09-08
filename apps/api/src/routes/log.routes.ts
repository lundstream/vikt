import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createManualIntakeSchema,
  createWeightEntrySchema,
  dateRangeQuerySchema,
  errorResponseSchema,
  intakeSeriesSchema,
  localDateSchema,
  manualIntakeListSchema,
  manualIntakeSchema,
  weightEntrySchema,
  weightListSchema,
} from "shared";
import {
  getWeightEntries,
  removeWeightEntry,
  saveWeightEntry,
} from "../services/weight.service.js";
import {
  getIntakeSeries,
  getManualIntake,
  removeManualIntake,
  saveManualIntake,
} from "../services/intake.service.js";

/**
 * Weight and manual intake.
 *
 * Both POSTs are upserts on `(user_id, client_uuid)` and return 200 rather than
 * 201: the offline queue replays them and a replay is a normal, successful
 * outcome, not a conflict (CLAUDE.md §3).
 *
 * `userId` comes from `request.userId`, set by `requireAuth`, and never from
 * the body or the query string.
 */
export const logRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/weight",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createWeightEntrySchema,
        response: {
          200: weightEntrySchema,
          401: errorResponseSchema,
          // A queued write whose day was written elsewhere first (D41).
          409: errorResponseSchema,
        },
      },
    },
    async (request) => saveWeightEntry(request.userId!, app.db, request.body),
  );

  app.get(
    "/weight",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dateRangeQuerySchema,
        response: { 200: weightListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getWeightEntries(request.userId!, app.db, request.query),
    }),
  );

  /**
   * Removes a reading.
   *
   * Everything derived from the weight series is recomputed on the next read,
   * so this needs no companion cleanup: the trend, both projections and the
   * maintenance figure simply come back different. An achieved milestone is
   * **not** revoked (D8): it happened.
   *
   * Editing is the same POST as logging. `(user_id, local_date)` holds one
   * canonical reading per day, so re-posting the day replaces it, which is what
   * "edit" means for this table.
   */
  app.delete(
    "/weight/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          204: z.null(),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await removeWeightEntry(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/manual-intake",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createManualIntakeSchema,
        response: { 200: manualIntakeSchema, 401: errorResponseSchema },
      },
    },
    async (request) => saveManualIntake(request.userId!, app.db, request.body),
  );

  /**
   * Deleting the manual row hands the day back to its food entries (D44).
   * Immediate, like the weight delete and for the same reason: the row is
   * small, replaceable and entirely the user's.
   */
  app.delete(
    "/manual-intake/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeManualIntake(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * The resolved intake series, for the data viewer.
   *
   * A separate endpoint rather than something the client assembles: a day's
   * intake has one definition and it lives on the server (D44). Bounded on
   * both ends, because this is a window into a range rather than the whole
   * history the other log endpoints hand over.
   */
  app.get(
    "/intake-series",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: z.object({ from: localDateSchema, to: localDateSchema }),
        response: { 200: intakeSeriesSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      getIntakeSeries(request.userId!, app.db, {
        from: request.query.from,
        to: request.query.to,
      }),
  );

  app.get(
    "/manual-intake",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dateRangeQuerySchema,
        response: { 200: manualIntakeListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getManualIntake(request.userId!, app.db, request.query),
    }),
  );
};
