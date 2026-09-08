import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { errorResponseSchema, insightsQuerySchema, insightsResponseSchema } from "shared";
import { getInsights } from "../services/insights.service.js";

/**
 * `GET /api/insights?asOf=YYYY-MM-DD`
 *
 * `asOf` is the client's local date. It is a parameter rather than something
 * the server works out, for the same reason `local_date` is on every log row:
 * the server does not know what day it is where the user is (CLAUDE.md §3).
 * Falling back to the server's UTC date would put a late-evening reading in
 * tomorrow's window.
 */
export const insightsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/insights",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: insightsQuerySchema,
        response: { 200: insightsResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      const asOf = request.query.asOf ?? new Date().toISOString().slice(0, 10);
      return getInsights(request.userId!, app.db, asOf, app.config.SYSTEM_INTAKE_FLOOR_KCAL);
    },
  );
};
