import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  errorResponseSchema,
  loginRequestSchema,
  meResponseSchema,
  registerRequestSchema,
} from "shared";
import { login, logout, register } from "../services/auth.service.js";

/**
 * Routes stay thin: validate with the shared Zod schema, call the service,
 * set or clear the cookie. No business logic lives here.
 */
export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const sessionTtlDays = app.config.SESSION_TTL_DAYS;

  app.post(
    "/register",
    {
      schema: {
        body: registerRequestSchema,
        response: {
          201: meResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, session } = await register(
        { db: app.db, sessionTtlDays },
        request.body,
        request.headers["user-agent"] ?? null,
      );
      app.setSessionCookie(reply, session.token, session.expiresAt);
      return reply.code(201).send(user);
    },
  );

  app.post(
    "/login",
    {
      schema: {
        body: loginRequestSchema,
        response: { 200: meResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { user, session } = await login(
        { db: app.db, sessionTtlDays },
        request.body,
        request.headers["user-agent"] ?? null,
      );
      app.setSessionCookie(reply, session.token, session.expiresAt);
      return reply.send(user);
    },
  );

  app.post(
    "/logout",
    {
      preHandler: app.requireAuth,
      schema: { response: { 204: z.null() } },
    },
    async (request, reply) => {
      await logout(request.userId!, app.db, request.sessionToken!);
      app.clearSessionCookie(reply);
      return reply.code(204).send(null);
    },
  );
};
