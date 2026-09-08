import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { errorResponseSchema, meResponseSchema, updateProfileSchema } from "shared";
import { getMe } from "../services/auth.service.js";
import { editProfile } from "../services/profile.service.js";

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/me",
    {
      preHandler: app.requireAuth,
      schema: {
        response: { 200: meResponseSchema, 401: errorResponseSchema },
      },
    },
    // `request.userId` is set by requireAuth and is the only source of scope.
    async (request) => getMe(request.userId!, app.db),
  );

  app.patch(
    "/me/profile",
    {
      preHandler: app.requireAuth,
      schema: {
        body: updateProfileSchema,
        response: {
          200: meResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) => editProfile(request.userId!, app.db, request.body),
  );
};
