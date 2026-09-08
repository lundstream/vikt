import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { resolveSession } from "../services/auth.service.js";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
import { notFound, unauthorized } from "../lib/errors.js";

/**
 * Session cookie handling and the `requireAuth` hook.
 *
 * Anything that reads user data hangs off `requireAuth`, which puts `userId` on
 * the request. Route handlers pass `request.userId` into the service layer as
 * the first argument and never derive it from the body or the query string.
 */

export const SESSION_COOKIE = "vikt_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireAuth`. Undefined on unauthenticated routes. */
    userId?: string;
    sessionId?: string;
    /** The raw cookie token, needed by logout to delete the right row. */
    sessionToken?: string;
    /**
     * The address to attribute this request to: `CF-Connecting-IP` when the
     * peer is trusted, otherwise Fastify's own resolution. Computed on access
     * — see the getter in app.ts and lib/trust-proxy.ts.
     */
    readonly clientIp: string;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * The app's first authorisation concept (D89).
     *
     * Composed on top of `requireAuth` rather than beside it: an admin route
     * that forgot to also require a session would be an open endpoint, and the
     * only way to make that impossible is for the admin check to *be* the
     * session check plus one more question.
     */
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    setSessionCookie: (reply: FastifyReply, token: string, expiresAt: Date) => void;
    clearSessionCookie: (reply: FastifyReply) => void;
  }
}

export type AuthPluginOptions = {
  cookieSecure: boolean;
};

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: options.cookieSecure,
    /**
     * Scoped to the API (D90).
     *
     * It used to be `/`, which was right when the app *was* the site. Now the
     * root is a public landing page, and a session cookie sent with every
     * request for that page is a cookie handed to a surface that has no use for
     * it. `/api` is the only path that reads it.
     */
    path: "/api",
  };

  app.decorate("setSessionCookie", (reply: FastifyReply, token: string, expiresAt: Date) => {
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
  });

  app.decorate("clearSessionCookie", (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
  });

  app.decorate("requireAuth", async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw unauthorized();

    const session = await resolveSession(app.db, token);
    if (!session) {
      // Expired or revoked. Drop the dead cookie so the browser stops sending it.
      app.clearSessionCookie(_reply);
      throw unauthorized("Your session has expired. Sign in again.");
    }

    request.userId = session.userId;
    request.sessionId = session.sessionId;
    request.sessionToken = token;
  });

  app.decorate("requireAdmin", async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(request, reply);

    const [row] = await app.db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, request.userId!))
      .limit(1);

    /**
     * Read from the database on every request, never from the session.
     *
     * A flag copied into the session at sign-in would keep working after the
     * flag was removed, for as long as that session lived. The extra query is
     * one indexed primary-key lookup on a handful of admin routes.
     *
     * 404 rather than 403, because a non-admin has no business knowing these
     * endpoints exist.
     */
    if (!row?.isAdmin) throw notFound("Not found.");
  });
};

export const authPlugin = fp(plugin, { name: "auth", dependencies: ["@fastify/cookie"] });
