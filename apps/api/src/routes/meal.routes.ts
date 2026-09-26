import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  PHOTO_MAX_BASE64,
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
  readMealPhoto,
  removeMeal,
  removeMealPhoto,
  setMealPhoto,
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
      const removed = await removeMeal(request.userId!, app.db, request.params.mealId);
      // The photo goes with the meal (D191). After the row, so a failed delete
      // of the row cannot leave a meal pointing at a file that is gone.
      if (removed.photoKey !== null) await app.media.delete(removed.photoKey).catch(() => {});
      return reply.code(204).send(null);
    },
  );

  /**
   * The photo (D191). Put replaces, delete removes, get serves, all scoped to
   * the session's user; the image never passes through a public URL.
   */
  app.put(
    "/meals/:mealId/photo",
    {
      preHandler: app.requireAuth,
      bodyLimit: PHOTO_MAX_BASE64 + 4096,
      schema: {
        params,
        body: z.object({ image: z.string().min(32).max(PHOTO_MAX_BASE64) }),
        response: {
          200: mealSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) =>
      setMealPhoto(request.userId!, app.db, app.media, request.params.mealId, request.body.image),
  );

  app.delete(
    "/meals/:mealId/photo",
    {
      preHandler: app.requireAuth,
      schema: {
        params,
        response: { 200: mealSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => removeMealPhoto(request.userId!, app.db, app.media, request.params.mealId),
  );

  app.get(
    "/meals/:mealId/photo",
    {
      preHandler: app.requireAuth,
      schema: { params },
    },
    async (request, reply) => {
      const bytes = await readMealPhoto(request.userId!, app.db, app.media, request.params.mealId);
      return reply
        .header("content-type", "image/jpeg")
        // Private: the URL carries a version, so a day is safe, and nothing
        // between here and the browser may keep a copy.
        .header("cache-control", "private, max-age=86400")
        .send(bytes);
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
