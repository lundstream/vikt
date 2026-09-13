import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  activityListSchema,
  activitySchema,
  correlationsQuerySchema,
  correlationsResponseSchema,
  createActivitySchema,
  createDailyLogSchema,
  createMeasurementSchema,
  dailyLogListSchema,
  dailyLogSchema,
  dateRangeQuerySchema,
  dayLogSchema,
  errorResponseSchema,
  measurementListSchema,
  measurementSchema,
} from "shared";
import {
  getActivities,
  getDailyLogs,
  removeDailyLog,
  removeMeasurement,
  getDayLog,
  getMeasurements,
  removeActivity,
  saveActivity,
  saveDailyLog,
  saveMeasurement,
} from "../services/daily.service.js";
import { getCorrelations } from "../services/correlation.service.js";

/**
 * Measurements, the daily log, activity and the correlation view.
 *
 * Every POST is an upsert on `(user_id, client_uuid)` returning 200, not 201:
 * the offline queue replays them and a replay is a normal successful outcome
 * (CLAUDE.md §3).
 *
 * `userId` comes from `request.userId`, set by `requireAuth`, never from the
 * body or the query string.
 */

/** `?asOf=` — the client's local date. The server never derives one. */
const dayQuerySchema = z.object({
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
});

export const dailyRoutes: FastifyPluginAsyncZod = async (app) => {
  /* ---------------------------------------------------------- measurements */

  app.post(
    "/measurement",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createMeasurementSchema,
        response: { 200: measurementSchema, 401: errorResponseSchema },
      },
    },
    async (request) => saveMeasurement(request.userId!, app.db, request.body),
  );

  app.get(
    "/measurement",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dateRangeQuerySchema,
        response: { 200: measurementListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getMeasurements(request.userId!, app.db, request.query),
    }),
  );

  /**
   * Removing a day's measurement (D56, closed).
   *
   * The entity had `POST` and `GET` and nothing else from phase 4 until now,
   * which made it the oldest open item under §3's rule that every user-created
   * row ships with edit and delete. Re-logging the day was the edit; there was
   * no way to take a reading back at all.
   */
  app.delete(
    "/measurement/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeMeasurement(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /* ------------------------------------------------------------ daily log */

  app.post(
    "/daily",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createDailyLogSchema,
        response: { 200: dailyLogSchema, 401: errorResponseSchema },
      },
    },
    async (request) => saveDailyLog(request.userId!, app.db, request.body),
  );

  app.get(
    "/daily",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dateRangeQuerySchema,
        response: { 200: dailyLogListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getDailyLogs(request.userId!, app.db, request.query),
    }),
  );

  /**
   * Removes a day's ratings. The day becomes unlogged, which is not the same as
   * a day of zeroes: absent stays absent everywhere downstream, including in
   * the sober counter and the correlation view.
   */
  app.delete(
    "/daily/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeDailyLog(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /**
   * Everything logged for one day, in one request. The daily screen opens
   * filled in rather than blank — logging a day is mostly amending it.
   */
  app.get(
    "/day",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dayQuerySchema,
        response: { 200: dayLogSchema, 401: errorResponseSchema },
      },
    },
    async (request) => getDayLog(request.userId!, app.db, request.query.localDate),
  );

  /* ------------------------------------------------------------- activity */

  app.post(
    "/activity",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createActivitySchema,
        response: { 200: activitySchema, 401: errorResponseSchema },
      },
    },
    async (request) => saveActivity(request.userId!, app.db, request.body),
  );

  app.get(
    "/activity",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dateRangeQuerySchema,
        response: { 200: activityListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getActivities(request.userId!, app.db, request.query),
    }),
  );

  app.delete(
    "/activity/:id",
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
      await removeActivity(request.userId!, app.db, request.params.id);
      return reply.code(204).send(null);
    },
  );

  /* ---------------------------------------------------------- correlations */

  /**
   * Points, sample size and date range. No coefficient, by decision (D34) —
   * see `calc/correlate.ts` for why.
   */
  app.get(
    "/correlations",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: correlationsQuerySchema,
        response: { 200: correlationsResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      getCorrelations(
        request.userId!,
        app.db,
        request.query.asOf ?? new Date().toISOString().slice(0, 10),
      ),
  );
};
