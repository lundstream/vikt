import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createMealSchema,
  errorResponseSchema,
  logMealSchema,
  mealListSchema,
  mealLogResultSchema,
  mealSchema,
  updateMealSchema,
} from "shared";
import {
  createMeal,
  editMeal,
  getMeal,
  getMeals,
  logMeal,
  removeMeal,
} from "../services/meal.service.js";

/**
 * Måltider (Phase 14, D186). Create, read, edit, remove and log, all scoped to
 * the session's user; `userId` never comes from a body or a path (§3).
 *
 * The template routes these replace (`/meal-templates`) are gone rather than
 * aliased: nothing outside this repository calls them, and a second name for
 * the same thing is how two screens come to disagree.
 */
export const mealRoutes: FastifyPluginAsyncZod = async (app) => {
  const params = z.object({ mealId: z.string().uuid() });

  app.get(
    "/meals",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: mealListSchema, 401: errorResponseSchema } },
    },
    async (request) => ({ meals: await getMeals(request.userId!, app.db) }),
  );

  app.post(
    "/meals",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createMealSchema,
        response: { 201: mealSchema, 401: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const meal = await createMeal(request.userId!, app.db, request.body);
      return reply.code(201).send(meal);
    },
  );

  app.get(
    "/meals/:mealId",
    {
      preHandler: app.requireAuth,
      schema: {
        params,
        response: { 200: mealSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => getMeal(request.userId!, app.db, request.params.mealId),
  );

  app.patch(
    "/meals/:mealId",
    {
      preHandler: app.requireAuth,
      schema: {
        params,
        body: updateMealSchema,
        response: {
          200: mealSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => editMeal(request.userId!, app.db, request.params.mealId, request.body),
  );

  app.delete(
    "/meals/:mealId",
    {
      preHandler: app.requireAuth,
      schema: {
        params,
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeMeal(request.userId!, app.db, request.params.mealId);
      return reply.code(204).send(null);
    },
  );

  app.post(
    "/meals/:mealId/log",
    {
      preHandler: app.requireAuth,
      schema: {
        params,
        body: logMealSchema,
        response: {
          200: mealLogResultSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => logMeal(request.userId!, app.db, request.params.mealId, request.body),
  );
};
