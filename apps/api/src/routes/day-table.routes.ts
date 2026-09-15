import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { dayTableQuerySchema, dayTableResponseSchema, errorResponseSchema } from "shared";
import { getDayTable } from "../services/day-table.service.js";

/**
 * The day table under Data (D167). Scoped to the session's own account, like
 * every read of logged data.
 */
export const dayTableRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/day-table",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dayTableQuerySchema,
        response: { 200: dayTableResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      getDayTable(request.userId!, app.db, { from: request.query.from, to: request.query.to }),
  );
};
