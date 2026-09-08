import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createFoodPortionSchema,
  createPantryStapleSchema,
  createSavedRecipeSchema,
  errorResponseSchema,
  foodPortionSchema,
  pantryStapleSchema,
  savedRecipeSchema,
  updateFoodPortionSchema,
  updatePantryStapleSchema,
  updateSavedRecipeSchema,
} from "shared";
import {
  addStaple,
  editPortion,
  editRecipe,
  editStaple,
  getPortions,
  getRecipes,
  getStaples,
  removePortion,
  removeRecipe,
  removeStaple,
  savePortion,
  saveRecipe,
  seedStaplesIfNeeded,
} from "../services/portions.service.js";

/**
 * Portions, pantry staples and saved recipes (§6 phase 8).
 *
 * Three user-owned collections, and every one of them ships with edit and
 * delete in the phase that creates it (§3, D56). That rule has been broken four
 * times in this codebase and each time it was found by using the app, so the
 * routes are written together with the creates rather than after them.
 */
const idParams = z.object({ id: z.string().uuid() });

export const portionRoutes: FastifyPluginAsyncZod = async (app) => {
  /* ----------------------------------------------------------- portions */

  app.get(
    "/portions",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ portions: z.array(foodPortionSchema) }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({ portions: await getPortions(request.userId!, app.db) }),
  );

  /**
   * Defining a portion is an upsert on `(user, food, unit)`.
   *
   * Saying "a slice is 42 g" twice is one portion corrected, not two portions,
   * and the second figure is the one the user just looked at.
   */
  app.post(
    "/portions",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createFoodPortionSchema,
        response: { 200: foodPortionSchema, 401: errorResponseSchema },
      },
    },
    async (request) => savePortion(request.userId!, app.db, request.body),
  );

  app.patch(
    "/portions/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        body: updateFoodPortionSchema,
        response: {
          200: foodPortionSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const portion = await editPortion(
        request.userId!,
        app.db,
        request.params.id,
        request.body,
      );
      if (!portion) return reply.code(404).send({ error: "not_found", message: "Finns inte." });
      return portion;
    },
  );

  app.delete(
    "/portions/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        response: {
          200: z.object({ deleted: z.boolean() }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deleted = await removePortion(request.userId!, app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "not_found", message: "Finns inte." });
      return { deleted };
    },
  );

  /* ---------------------------------------------------- pantry staples */

  /**
   * The list, seeded on first read.
   *
   * Seeding here rather than at registration because the default list is only
   * useful once there is a food database to match it against, and because a
   * user who never opens the recipe screen never needs it. The guard is a
   * timestamp on the profile, so an emptied list stays empty (§3).
   */
  app.get(
    "/pantry",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ staples: z.array(pantryStapleSchema) }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      await seedStaplesIfNeeded(request.userId!, app.db);
      return { staples: await getStaples(request.userId!, app.db) };
    },
  );

  app.post(
    "/pantry",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createPantryStapleSchema,
        response: { 200: pantryStapleSchema, 401: errorResponseSchema },
      },
    },
    async (request) => addStaple(request.userId!, app.db, request.body),
  );

  app.patch(
    "/pantry/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        body: updatePantryStapleSchema,
        response: {
          200: pantryStapleSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const staple = await editStaple(request.userId!, app.db, request.params.id, request.body);
      if (!staple) return reply.code(404).send({ error: "not_found", message: "Finns inte." });
      return staple;
    },
  );

  app.delete(
    "/pantry/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        response: {
          200: z.object({ deleted: z.boolean() }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deleted = await removeStaple(request.userId!, app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "not_found", message: "Finns inte." });
      return { deleted };
    },
  );

  /* ----------------------------------------------------- saved recipes */

  app.get(
    "/recipes",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ recipes: z.array(savedRecipeSchema) }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({ recipes: await getRecipes(request.userId!, app.db) }),
  );

  /**
   * Saving freezes the text (§6).
   *
   * The first model-generated prose this app stores. Regenerating the same dish
   * produces different words, so a saved recipe that re-derived itself would be
   * a record of something that never happened. It is stored as written and
   * edited by hand from then on.
   */
  app.post(
    "/recipes",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createSavedRecipeSchema,
        response: { 200: savedRecipeSchema, 401: errorResponseSchema },
      },
    },
    async (request) => saveRecipe(request.userId!, app.db, request.body),
  );

  app.patch(
    "/recipes/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        body: updateSavedRecipeSchema,
        response: {
          200: savedRecipeSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const recipe = await editRecipe(request.userId!, app.db, request.params.id, request.body);
      if (!recipe) return reply.code(404).send({ error: "not_found", message: "Finns inte." });
      return recipe;
    },
  );

  app.delete(
    "/recipes/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        response: {
          200: z.object({ deleted: z.boolean() }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const deleted = await removeRecipe(request.userId!, app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "not_found", message: "Finns inte." });
      return { deleted };
    },
  );
};
