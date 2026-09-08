import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { errorResponseSchema } from "shared";
import { outboundEmail, users } from "../db/schema.js";
import { queueMail } from "../mail/queue.js";
import { isLocalBaseUrl, publicBaseUrl } from "../lib/links.js";
import { drainOnce } from "../mail/drainer.js";
import { testMail } from "../mail/templates.js";
import { secretsAvailable } from "../lib/secrets.js";
import {
  readMailSettings,
  writeMailSettings,
  type MailSecurity,
} from "../services/mail-settings.service.js";

/**
 * Mail settings, from the admin screen (D102).
 *
 * Everything here is behind `requireAdmin`, which answers 404 rather than 403,
 * so a non-admin cannot learn that these endpoints exist.
 */

const settingsSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  security: z.enum(["starttls", "tls", "none"]),
  username: z.string(),
  hasPassword: z.boolean(),
  fromAddress: z.string(),
  fromName: z.string(),
  updatedAt: z.string().nullable(),
  updatedByEmail: z.string().nullable(),
  secretsReadable: z.boolean(),
});

/**
 * The write shape.
 *
 * `password` is optional and that is load-bearing: **absent leaves the stored
 * one alone**, so an admin can change a port without retyping a password the
 * screen never showed them. An empty string clears it, which is a different
 * intention and has to be expressible.
 */
const updateSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["starttls", "tls", "none"]),
  username: z.string().max(320),
  password: z.string().max(512).optional(),
  fromAddress: z.string().email(),
  fromName: z.string().max(120),
});

export const mailSettingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/admin/mail-settings",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            settings: settingsSchema.nullable(),
            /** Whether a password could be stored at all, for the screen to say so. */
            secretKeyPresent: z.boolean(),
            /**
             * The base every link in every mail is built from, and whether it
             * is a local address (D113).
             *
             * On the screen rather than only in the environment, because
             * `https://localhost:5173` sat in a live instance's `.env` and
             * every invite went out linking to a dev server. Nothing in the
             * app said so: the mail sent, the queue said sent, and the only
             * way to find out was to read a delivered message. The value that
             * decides it is now printed where the person sending the mail is
             * already standing.
             */
            baseUrl: z.string().nullable(),
            baseUrlIsLocal: z.boolean(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async () => {
      const base = publicBaseUrl(app.config);
      return {
        settings: await readMailSettings(app.db),
        secretKeyPresent: secretsAvailable(),
        baseUrl: base,
        baseUrlIsLocal: base !== null && isLocalBaseUrl(base),
      };
    },
  );

  app.put(
    "/admin/mail-settings",
    {
      preHandler: app.requireAdmin,
      schema: {
        body: updateSchema,
        response: {
          200: z.object({ ok: z.literal(true) }),
          422: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = await actorFor(app, request.userId!);
      const result = await writeMailSettings(app.db, actor, {
        host: request.body.host,
        port: request.body.port,
        security: request.body.security as MailSecurity,
        username: request.body.username,
        password: request.body.password,
        fromAddress: request.body.fromAddress,
        fromName: request.body.fromName,
      });

      if (!result.ok) {
        return reply.code(422).send({
          error: result.reason,
          message:
            "SECRET_KEY is not set, so a password cannot be stored encrypted. " +
            "Set SECRET_KEY or SECRET_KEY_FILE and try again.",
        });
      }

      // The transport is cached, so the next send has to be told to rebuild it.
      await app.mailer.refresh();
      return { ok: true as const };
    },
  );

  /**
   * A test message, to the signed-in admin and nobody else.
   *
   * **The recipient is not a parameter.** An endpoint that sends arbitrary text
   * to an arbitrary address is an open relay wearing a diagnostic hat, and it
   * would be reachable by anyone who reached an admin session. The address comes
   * from the session, so the worst this can do is mail the person pressing it.
   *
   * **It goes through the queue now** (D109), which reverses D102's exception.
   * That exception was defensible on its own terms — an answer that arrives via
   * a queue thirty seconds later is a poor answer — and it was wrong for a
   * reason nobody had thought of: it made the test prove the *transport* while
   * saying nothing about the *path every real message takes*. So a working test
   * button coexisted for an hour with a queue nothing was draining, and every
   * visible signal said mail worked.
   *
   * A test that does not exercise the thing it is testing is worse than no
   * test, because it is believed. This one is queued at priority 0 and the
   * drainer is asked to run immediately, so the answer still arrives in about a
   * second and now means what somebody pressing the button thinks it means.
   */
  app.post(
    "/admin/mail-settings/test",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            ok: z.boolean(),
            to: z.string(),
            reason: z.string().nullable(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);

      if (!app.mailer.enabled) {
        return {
          ok: false,
          to: actor.email,
          reason: "mail is not configured",
        };
      }

      const id = await queueMail(app.db, actor.email, testMail(), { priority: 0 });

      /**
       * Drained here, once, rather than waiting for the tick.
       *
       * This is still not "sent inside the request" in D88's sense: the row
       * exists and survives whatever happens next, so a hung SMTP conversation
       * loses the answer and not the message. What the caller gets back is the
       * queue row's own outcome, which is the outcome every other mail gets.
       */
      await drainOnce(app.db, app.mailer);

      const [row] = await app.db
        .select()
        .from(outboundEmail)
        .where(eq(outboundEmail.id, id))
        .limit(1);

      return {
        ok: row?.status === "sent",
        to: actor.email,
        reason: row?.status === "sent" ? null : (row?.lastError ?? "still queued"),
      };
    },
  );
};

/** Who is acting, for the audit log (D95). */
async function actorFor(app: Parameters<FastifyPluginAsyncZod>[0], userId: string) {
  const [row] = await app.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row!;
}
