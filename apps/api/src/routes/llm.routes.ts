import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import {
  confirmParsedSchema,
  estimateDishSchema,
  estimateResponseSchema,
  errorResponseSchema,
  foodEntryListSchema,
  llmHealthSchema,
  parseFoodPhotoRequestSchema,
  parseFoodRequestSchema,
  parseFoodResponseSchema,
  parsePhotoResponseSchema,
  PHOTO_MAX_BASE64,
  recipeRequestSchema,
  recipeResponseSchema,
} from "shared";
import {
  estimateDish,
  generateRecipe,
  llmHealth,
  parseFoodPhoto,
  parseFoodText,
} from "../services/llm.service.js";
import { saveFoodEntry } from "../services/food.service.js";

/**
 * The optional LLM layer (§6 phase 8).
 *
 * Every route here answers **200 even when the layer is unavailable**, carrying
 * a discriminated result instead. That is not laziness about status codes: the
 * brief's first sentence about this phase is that the workstation is not always
 * on and nothing may depend on it, and a 503 makes every client treat a
 * switched-off machine as a fault. The degradation is supposed to be invisible.
 */
export const llmRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * What the client asks before offering any of this.
   *
   * Cheap and frequently called, so the client's own reachability probe has a
   * two second budget: a host that cannot say its version in two seconds is not
   * one to put a person in front of.
   */
  app.get(
    "/llm/health",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: llmHealthSchema, 401: errorResponseSchema } },
    },
    async () => llmHealth(app.config, app.llm),
  );

  /**
   * Free text to named foods with database nutrition.
   *
   * **Reads and writes nothing.** The user sees the matches, corrects the
   * portions, and confirms; only then does anything reach `food_entries`. A
   * mis-parsed portion that was saved first would already be inside the intake
   * series, and therefore inside the §4.2 maintenance figure and both
   * projections, before anyone had a chance to look at it.
   */
  app.post(
    "/llm/parse-food",
    {
      preHandler: app.requireAuth,
      schema: {
        body: parseFoodRequestSchema,
        response: { 200: parseFoodResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      parseFoodText(request.userId!, app.db, app.config, app.llm, request.body.text),
  );

  /**
   * A photograph of a plate, through the same path a sentence takes (D143).
   *
   * **The image is read and dropped.** Nothing on this path writes it: not to
   * disk, not to a table, not to a log line, and the client does not put it in
   * the offline queue. That is the condition under which photographing a meal
   * is an acceptable thing to ask of somebody, and it is asserted by
   * `photo-transport.test.ts` rather than left as an intention in a comment.
   *
   * Its own `bodyLimit`, because the server's default is one megabyte and a two
   * megabyte image is nearly three megabytes of base64. The limit is set from
   * the schema's own ceiling plus room for the envelope, so raising the ceiling
   * cannot leave a body limit behind that silently refuses the images the
   * schema now allows.
   */
  app.post(
    "/llm/parse-photo",
    {
      preHandler: app.requireAuth,
      bodyLimit: PHOTO_MAX_BASE64 + 4096,
      schema: {
        body: parseFoodPhotoRequestSchema,
        response: { 200: parsePhotoResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      parseFoodPhoto(
        request.userId!,
        app.db,
        app.config,
        app.llm,
        request.body,
        /**
         * The route's logger, not the request's. `request.log` carries the
         * request context, which is the right default everywhere else and is
         * beside the point here: what is wanted is one line saying a photo was
         * parsed and how long it took.
         */
        app.log,
      ),
  );

  /**
   * A recipe from what is in the fridge, inside what is left of the day.
   *
   * Reads and writes nothing, like the parser. Logging it is the *same*
   * confirm endpoint below: a recipe the user cooks is a set of food entries,
   * and giving it a second write path would give it a second chance to be
   * wrong.
   *
   * Slower than everything else in the app on purpose. The large model takes
   * eight seconds warm and thirty-one from cold, so this carries the job
   * budget rather than the interactive one.
   */
  app.post(
    "/llm/recipe",
    {
      preHandler: app.requireAuth,
      schema: {
        body: recipeRequestSchema,
        response: { 200: recipeResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) =>
      generateRecipe(request.userId!, app.db, app.config, app.llm, request.body, app.log),
  );

  /**
   * What a dish is worth, when nothing in any database can say (D81).
   *
   * The single exception to D5, and its conditions are in the request body
   * rather than assumed: the app must already have failed to find the item, and
   * either failed to decompose it or had the decomposition rejected, and the
   * user must have asked. `requested` is a literal `true` in the schema, so a
   * client cannot reach this by accident and one that hard-codes it is doing so
   * where a reader can see it.
   *
   * Writes nothing. The estimate comes back as a proposal with the range it was
   * honest about and what it was based on; accepting it goes through
   * `POST /food/estimate` like any other hand-made item, which is what makes an
   * accepted estimate a normal, editable, reusable food.
   */
  app.post(
    "/llm/estimate",
    {
      preHandler: app.requireAuth,
      schema: {
        body: estimateDishSchema,
        response: { 200: estimateResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => {
      app.log.info(
        { after: request.body.after },
        "dish estimate requested",
      );
      return estimateDish(app.config, app.llm, request.body.dish);
    },
  );

  /**
   * The rows the user accepted, after correcting them.
   *
   * Ordinary food entries, through the ordinary service: same upsert, same
   * `client_uuid` idempotency, same macro snapshot. Nothing about an entry
   * records that a model suggested it, because by this point a person has read
   * every row and changed the ones that were wrong — which makes it their
   * entry, not the model's.
   */
  app.post(
    "/llm/parse-food/confirm",
    {
      preHandler: app.requireAuth,
      schema: {
        body: confirmParsedSchema,
        response: {
          200: foodEntryListSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { localDate, mealSlot, items } = request.body;

      /**
       * An unmatched row must arrive with a value (D74).
       *
       * The version this replaced sent zero for anything the database could
       * not price, which wrote a zero-energy entry and made the day's intake
       * silently low, in the one place where the app itself is doing the
       * writing rather than reporting. Zero is still a legal answer; it just
       * has to be *chosen*, which is what marking an ingredient negligible
       * does on the screen.
       */
      const unpriced = items.filter(
        (item) => item.foodItemId === null && (item.kcal === null || item.kcal === undefined),
      );
      if (unpriced.length > 0) {
        return reply.code(422).send({
          error: "unpriced_items",
          message: `Saknar energivärde: ${unpriced.map((item) => item.name).join(", ")}.`,
        });
      }

      const entries = [];
      for (const item of items) {
        entries.push(
          await saveFoodEntry(request.userId!, app.db, {
            clientUuid: item.clientUuid,
            localDate,
            mealSlot,
            foodItemId: item.foodItemId,
            // Kept as freetext when nothing matched, so the row still says what
            // was eaten even though the app cannot say what was in it.
            freetext: item.foodItemId ? null : item.name,
            grams: item.grams,
            /**
             * An unmatched row has no energy to compute, and `saveFoodEntry`
             * refuses a row it cannot price (`no_energy`). Zero is sent rather
             * than nothing so the refusal does not reach the user for a row
             * they deliberately kept as a note.
             */
            ...(item.foodItemId ? {} : { kcal: item.kcal ?? 0 }),
            confidence: 1,
            confirmed: true,
          }),
        );
      }

      return { entries };
    },
  );
};
