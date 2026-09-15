import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  applyTemplateSchema,
  barcodeLookupSchema,
  barcodeSchema,
  createFoodEntrySchema,
  createTemplateSchema,
  dateRangeQuerySchema,
  errorResponseSchema,
  foodEntryListSchema,
  foodEntrySchema,
  foodItemSchema,
  foodSearchQuerySchema,
  foodSearchResultSchema,
  mealTemplateListSchema,
  mealTemplateSchema,
  updateFoodEntrySchema,
  updateTemplateSchema,
  createEstimateSchema,
  favouriteSchema,
} from "shared";
import {
  createManualFood,
  getFoodEntries,
  getRecentFoods,
  lookupBarcode,
  removeFoodEntry,
  editFoodEntry,
  saveFoodEntry,
  createEstimate,
  getFavourites,
  searchFood,
  starFood,
} from "../services/food.service.js";
import {
  applyTemplate,
  createTemplate,
  editTemplate,
  getTemplate,
  getTemplates,
  removeTemplate,
} from "../services/template.service.js";

/**
 * Food logging.
 *
 * `userId` comes from `request.userId` throughout, never from the body — and
 * `food_items` is a shared cache, so the scoping there is about *visibility*
 * rather than ownership (see food.repo.ts).
 */
export const foodRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/food/barcode/:barcode",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ barcode: barcodeSchema }),
        response: { 200: barcodeLookupSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      lookupBarcode(
        request.userId!,
        { db: app.db, adapters: app.foodAdapters },
        request.params.barcode,
      ),
  );

  app.get(
    "/food/search",
    {
      preHandler: app.requireAuth,
      schema: {
        // The minimum length lives in the schema, so search can never be wired
        // straight to keystrokes without the server refusing.
        querystring: foodSearchQuerySchema,
        response: { 200: foodSearchResultSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      searchFood(
        request.userId!,
        {
          db: app.db,
          adapters: app.foodAdapters,
          remoteTimeoutMs: app.foodRemoteTimeoutMs ?? undefined,
        },
        request.query.q,
        request.query.limit,
        request.query.source,
      ),
  );

  /**
   * A restaurant meal or a takeaway, valued by the person who ate it (D80).
   *
   * Separate from `/food/manual` because the two are different acts. Manual is
   * "copy this packet's numbers"; this is "I am guessing, and the app should
   * remember that I was". The row is marked as an estimate for good, so every
   * screen it reaches can say so.
   */
  app.post(
    "/food/estimate",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createEstimateSchema,
        response: { 200: foodItemSchema, 401: errorResponseSchema },
      },
    },
    async (request) => createEstimate(request.userId!, app.db, request.body),
  );

  app.get(
    "/food/favourites",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ items: z.array(foodItemSchema) }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => ({ items: await getFavourites(request.userId!, app.db) }),
  );

  app.post(
    "/food/favourite",
    {
      preHandler: app.requireAuth,
      schema: {
        body: favouriteSchema,
        response: {
          200: z.object({ favourite: z.boolean() }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => {
      await starFood(
        request.userId!,
        app.db,
        request.body.foodItemId,
        request.body.favourite,
      );
      return { favourite: request.body.favourite };
    },
  );

  app.post(
    "/food/manual",
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({
          name: z.string().trim().min(1).max(200),
          kcalPer100: z.number().min(0).max(2000),
          brand: z.string().trim().max(120).nullish(),
        }),
        response: { 201: foodItemSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const item = await createManualFood(request.userId!, app.db, request.body);
      return reply.code(201).send(item);
    },
  );

  /* ---------------------------------------------------------- food entries */

  app.post(
    "/food-entry",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createFoodEntrySchema,
        response: {
          200: foodEntrySchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    // 200 rather than 201: this is an upsert on (user_id, client_uuid) and a
    // replay is a normal, successful outcome (§3).
    async (request) => saveFoodEntry(request.userId!, app.db, request.body),
  );

  app.get(
    "/food-entry",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: dateRangeQuerySchema,
        response: { 200: foodEntryListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getFoodEntries(request.userId!, app.db, request.query),
    }),
  );

  app.get(
    "/food-entry/recent",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
        response: { 200: foodEntryListSchema, 401: errorResponseSchema },
      },
    },
    async (request) => ({
      entries: await getRecentFoods(request.userId!, app.db, request.query.limit),
    }),
  );

  /* -------------------------------------------------------- meal templates */

  app.get(
    "/meal-templates",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: mealTemplateListSchema, 401: errorResponseSchema } },
    },
    async (request) => ({ templates: await getTemplates(request.userId!, app.db) }),
  );

  app.post(
    "/meal-templates",
    {
      preHandler: app.requireAuth,
      schema: {
        body: createTemplateSchema,
        response: { 201: mealTemplateSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const template = await createTemplate(request.userId!, app.db, request.body);
      return reply.code(201).send(template);
    },
  );

  app.patch(
    "/meal-templates/:templateId",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ templateId: z.string().uuid() }),
        body: updateTemplateSchema,
        response: {
          200: mealTemplateSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      editTemplate(request.userId!, app.db, request.params.templateId, request.body),
  );

  /**
   * Corrects a logged entry's amount (D56, D65). The macro snapshot is
   * recomputed from the food item, so 250 g mistyped for 150 leaves behind the
   * right calories rather than a corrected weight over the wrong ones.
   */
  app.patch(
    "/food-entry/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: updateFoodEntrySchema,
        response: {
          200: foodEntrySchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      editFoodEntry(request.userId!, app.db, request.params.id, request.body),
  );

  /**
   * Removes one logged food entry. The day's total is a sum over what remains,
   * so nothing stored needs correcting.
   */
  app.delete(
    "/food-entry/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null(), 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await removeFoodEntry(
        request.userId!,
        { db: app.db, adapters: app.foodAdapters },
        request.params.id,
      );
      return reply.code(204).send(null);
    },
  );

  app.delete(
    "/meal-templates/:templateId",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ templateId: z.string().uuid() }),
        response: {
          204: z.null(),
          401: errorResponseSchema,
          // The row is not the caller's, or is already gone.
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await removeTemplate(request.userId!, app.db, request.params.templateId);
      return reply.code(204).send(null);
    },
  );

  app.get(
    "/meal-templates/:templateId",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ templateId: z.string().uuid() }),
        response: {
          200: mealTemplateSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => getTemplate(request.userId!, app.db, request.params.templateId),
  );

  app.post(
    "/meal-templates/:templateId/apply",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ templateId: z.string().uuid() }),
        body: applyTemplateSchema,
        response: {
          200: foodEntryListSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => ({
      entries: await applyTemplate(
        request.userId!,
        app.db,
        request.params.templateId,
        request.body,
      ),
    }),
  );
};
