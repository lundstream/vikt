import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: z.object({
            status: z.literal("ok"),
            appName: z.string(),
            db: z.literal("up"),
            /**
             * Which optional modes this installation runs (D94).
             *
             * On the health endpoint rather than behind auth, because the
             * landing page needs to know whether to offer "be om en kod"
             * before anyone has signed in, and because an operator checking a
             * deployment should be able to see its shape with one curl.
             *
             * It discloses nothing an anonymous visitor could not already
             * infer from which pages answer.
             */
            modes: z.object({
              landing: z.boolean(),
              mail: z.boolean(),
              llm: z.boolean(),
            }),
          }),
        },
      },
    },
    async () => {
      await app.db.execute(sql`select 1`);
      return {
        status: "ok" as const,
        appName: app.config.APP_NAME,
        db: "up" as const,
        modes: {
          landing: app.config.LANDING_ENABLED,
          mail: app.mailer.enabled,
          llm: app.llm.enabled,
        },
      };
    },
  );
};
