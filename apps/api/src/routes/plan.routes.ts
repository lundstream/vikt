import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createPlanSchema,
  errorResponseSchema,
  planListSchema,
  planSchema,
  updatePlanSchema,
} from "shared";
import { createPlan, editPlan, getActivePlan, getPlans } from "../services/plan.service.js";
import { currentMaintenance } from "../services/insights.service.js";

/**
 * Plans.
 *
 * Phase 2 builds what these are for. What is here now is the row plus the §3
 * guardrails, which reject with 422 and a message written for the person
 * reading it.
 */
export const planRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/plans",
    {
      preHandler: app.requireAuth,
      schema: {
        // `asOf` is the client's local date, for the same reason /insights takes
        // one: the server does not know what day it is where the user is.
        querystring: z.object({ asOf: z.string().optional() }),
        body: createPlanSchema,
        response: { 201: planSchema, 401: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    async (request, reply) => {
      // The plan is validated against, and baselined on, today's maintenance.
      const maintenance = await currentMaintenance(request.userId!, app.db, request.query.asOf);
      const plan = await createPlan(request.userId!, app.db, request.body, {
        systemFloorKcal: app.config.SYSTEM_INTAKE_FLOOR_KCAL,
        tdee: maintenance.tdee,
        tdeeSource: maintenance.source,
      });
      return reply.code(201).send(plan);
    },
  );

  app.patch(
    "/plans/:planId",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ planId: z.string().uuid() }),
        querystring: z.object({ asOf: z.string().optional() }),
        body: updatePlanSchema,
        response: {
          200: planSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const maintenance = await currentMaintenance(request.userId!, app.db, request.query.asOf);
      return editPlan(request.userId!, app.db, request.params.planId, request.body, {
        systemFloorKcal: app.config.SYSTEM_INTAKE_FLOOR_KCAL,
        tdee: maintenance.tdee,
        tdeeSource: maintenance.source,
      });
    },
  );

  app.get(
    "/plans",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: planListSchema, 401: errorResponseSchema } },
    },
    async (request) => ({ plans: await getPlans(request.userId!, app.db) }),
  );

  app.get(
    "/plans/active",
    {
      preHandler: app.requireAuth,
      schema: {
        response: { 200: planSchema.nullable(), 401: errorResponseSchema },
      },
    },
    async (request) => getActivePlan(request.userId!, app.db),
  );
};
