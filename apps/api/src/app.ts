import Fastify from "fastify";
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
} from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { Env } from "./env.js";
import { createLlmClient, type LlmClient } from "./llm/client.js";
import { dbPlugin } from "./db/plugin.js";
import type { Db } from "./db/index.js";
import { authPlugin } from "./auth/plugin.js";
import { AppError } from "./lib/errors.js";
import {
  CF_CONNECTING_IP,
  compileTrustedPeers,
  resolveClientIp,
} from "./lib/trust-proxy.js";
import { authRoutes } from "./routes/auth.routes.js";
import { meRoutes } from "./routes/me.routes.js";
import { healthRoutes } from "./routes/health.routes.js";
import { logRoutes } from "./routes/log.routes.js";
import { planRoutes } from "./routes/plan.routes.js";
import { insightsRoutes } from "./routes/insights.routes.js";
import { foodRoutes } from "./routes/food.routes.js";
import { llmRoutes } from "./routes/llm.routes.js";
import { publicRoutes } from "./routes/public.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { mailSettingsRoutes } from "./routes/mail-settings.routes.js";
import { backupRoutes } from "./routes/backup.routes.js";
import { accountRoutes } from "./routes/account.routes.js";
import { announcementRoutes } from "./routes/announcement.routes.js";
import { pushRoutes } from "./routes/push.routes.js";
import { exportRoutes } from "./routes/export.routes.js";
import { dayTableRoutes } from "./routes/day-table.routes.js";
import { createMailer, type Mailer } from "./mail/sender.js";
import { portionRoutes } from "./routes/portions.routes.js";
import { dailyRoutes } from "./routes/daily.routes.js";
import { habitRoutes } from "./routes/habit.routes.js";
import { coachRoutes } from "./routes/coach.routes.js";
import { progressRoutes } from "./routes/progress.routes.js";
import type { FoodAdapter } from "./food/adapter.js";
import { OpenFoodFactsAdapter } from "./food/openfoodfacts.js";
import { LivsmedelsverketAdapter } from "./food/livsmedelsverket.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Env;
    /**
     * Ingest adapters, in the order they are consulted. Decorated once at boot
     * so the rate limiters inside them are shared across every request — the
     * Open Food Facts budget belongs to the server, not to a request (D30).
     */
    foodAdapters: FoodAdapter[];
    /**
     * The remote food search's deadline, or null for the service's own
     * (D165). Only tests set it, so a timeout can be exercised in milliseconds.
     */
    foodRemoteTimeoutMs: number | null;
    /**
     * The optional LLM layer (§6 phase 8). Decorated once so the client's
     * cached reachability is shared, and always present: `enabled` is false
     * when no host is configured, which is a supported configuration rather
     * than a missing dependency.
     */
    llm: LlmClient;
    mailer: Mailer;
  }
}

/**
 * The instance type with the Zod type provider attached. Spelled out because
 * `withTypeProvider()` alone leaves the server generic ambiguous, and an
 * ambiguous generic makes every downstream `FastifyPluginAsyncZod` complain.
 */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export type BuildAppOptions = {
  /**
   * Use this handle instead of opening a pool. Tests pass an open transaction
   * so every row a test writes is rolled back afterwards; nothing else should
   * pass anything here.
   */
  db?: Db;
  /** Replace the ingest adapters. Tests pass fixtures instead of the network. */
  foodAdapters?: FoodAdapter[];
  /** Shorten the remote food search's deadline. Tests only. */
  foodRemoteTimeoutMs?: number;
  /**
   * Replace the LLM client. Tests pass a stub, because the real one talks to a
   * workstation that may be off, and a suite whose result depends on that is
   * not a suite.
   */
  llm?: LlmClient;
  /**
   * A stub mailer, so tests can watch what would have been sent without an
   * SMTP server. Absent, the real one is built from the environment and is
   * disabled unless SMTP is configured.
   */
  mailer?: Mailer;
  /**
   * Send logs here instead of stdout. A testing seam: the client-IP resolution
   * is only observable through what gets logged, and it has been wrong there
   * before (see the `clientIp` getter below).
   */
  logStream?: NodeJS.WritableStream;
};

export async function buildApp(env: Env, options: BuildAppOptions = {}): Promise<App> {
  // Compiled once, at boot: a malformed CIDR should stop the process, not
  // surface as a wrong IP on every request afterwards.
  const trustedPeers = compileTrustedPeers(env.TRUST_PROXY);

  const app = Fastify<RawServerDefault>({
    logger: {
      level: env.LOG_LEVEL,
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Log the client IP that TRUST_PROXY resolved to, so a wrong hop count is
      // visible in the logs rather than silently rate-limiting the proxy.
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          // What we attribute the request to: CF-Connecting-IP when the peer is
          // trusted, otherwise Fastify's own resolution.
          ip: req.clientIp,
          // Kept alongside so a misconfigured TRUST_PROXY is visible in the
          // logs rather than having to be inferred.
          peer: req.socket?.remoteAddress,
        }),
      },
    },
    // Only the immediate peer named by TRUST_PROXY may speak for a client.
    // Verify from a cellular IP, not from the LAN (CLAUDE.md §2).
    trustProxy: trustedPeers,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("config", env);
  app.decorate("llm", options.llm ?? createLlmClient(env));
  /**
   * The mailer, decorated once (D88, D102).
   *
   * `enabled` is false when no mail server is configured, and every caller
   * checks it: a self-hosted install without one keeps working, with each
   * mail-backed feature degrading to a manual path rather than failing.
   *
   * The settings live in the database now, so the flag starts false and is set
   * by the `refresh()` below. A test that injects its own mailer keeps whatever
   * that one says.
   */
  app.decorate("mailer", options.mailer ?? createMailer(() => app.db, env));
  app.decorate(
    "foodAdapters",
    options.foodAdapters ?? [new OpenFoodFactsAdapter(), new LivsmedelsverketAdapter()],
  );
  app.decorate("foodRemoteTimeoutMs", options.foodRemoteTimeoutMs ?? null);

  /**
   * `request.clientIp` is the address to attribute a request to. Prefer it over
   * `request.ip` for anything user-facing — rate limiting, abuse handling, the
   * session record — because it is the one that survives Cloudflare. See
   * lib/trust-proxy.ts.
   *
   * A getter, not an `onRequest` hook: Fastify writes its "incoming request"
   * log line *before* hooks run, so a hook-assigned value was always still null
   * by the time the serialiser read it, and every log line quietly showed the
   * proxy's address instead. Computing on access is also free for requests that
   * never ask.
   */
  app.decorateRequest("clientIp", {
    getter(this: FastifyRequest) {
      return resolveClientIp({
        trust: trustedPeers,
        remoteAddress: this.socket.remoteAddress,
        cfConnectingIp: this.headers[CF_CONNECTING_IP],
        fallback: this.ip,
      });
    },
  });

  await app.register(helmet, {
    // nginx serves the frontend; this API returns JSON only, so no CSP here.
    contentSecurityPolicy: false,
  });
  await app.register(cookie, { secret: env.SESSION_SECRET });
  if (options.db) {
    app.decorate("db", options.db);
  } else {
    await app.register(dbPlugin, { databaseUrl: env.DATABASE_URL });
  }
  await app.register(authPlugin, { cookieSecure: env.COOKIE_SECURE });

  /**
   * Registered before the routes so every child context inherits it. Set it
   * afterwards and Fastify's own handler answers instead, which leaks its
   * `{ statusCode, error, message }` shape rather than the `{ error, message }`
   * contract the client validates.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: "validation_failed",
        message: error.validation
          .map((v) => `${v.instancePath || "body"}: ${v.message}`)
          .join("; "),
      });
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        // Only present on the errors that carry a payload the client has to
        // render, notably the queue's 409 (D41).
        ...(error.details ?? {}),
      });
    }

    // Fastify's own errors — unparseable JSON, empty body, payload too large,
    // unsupported media type — already carry the right 4xx status and a usable
    // message. Passing them through as 500s hides real client bugs behind
    // "Something went wrong".
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err: error }, "client error");
      return reply.code(statusCode).send({
        error: error.code ?? "bad_request",
        message: error.message,
      });
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({
      error: "internal_error",
      message: "Something went wrong.",
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not_found", message: "No such endpoint." }),
  );

  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(meRoutes);
      await api.register(logRoutes);
      await api.register(planRoutes);
      await api.register(insightsRoutes);
      await api.register(foodRoutes);
      await api.register(dailyRoutes);
      await api.register(habitRoutes);
      await api.register(coachRoutes);
      await api.register(progressRoutes);
      await api.register(llmRoutes);
      await api.register(portionRoutes);
      // Unauthenticated, rate limited on the D14 client address (D88, D89).
      await api.register(publicRoutes);
      await api.register(adminRoutes);
      await api.register(mailSettingsRoutes);
      await api.register(backupRoutes);
      await api.register(accountRoutes);
      await api.register(announcementRoutes);
      await api.register(pushRoutes);
      await api.register(exportRoutes);
      await api.register(dayTableRoutes);
    },
    { prefix: "/api" },
  );

  return app;
}
