import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { errorResponseSchema } from "shared";
import { users } from "../db/schema.js";
import {
  announcementsFor,
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  mailAnnouncement,
  markSeen,
  updateAnnouncement,
} from "../services/announcement.service.js";

/**
 * Announcements (D108).
 *
 * Two audiences on one table. The user endpoints are behind `requireAuth` and
 * scoped to the caller; the admin ones are behind `requireAdmin`, which answers
 * 404 rather than 403.
 */

const announcementSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["maintenance", "news", "notice"]),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  leadMinutes: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  published: z.boolean(),
  sendMail: z.boolean(),
  mailedAt: z.string().nullable(),
  createdByEmail: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const userAnnouncementSchema = announcementSchema.extend({ seen: z.boolean() });

const inputSchema = z.object({
  kind: z.enum(["maintenance", "news", "notice"]),
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  leadMinutes: z.number().int().min(0).max(43_200),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(4000).nullable(),
  published: z.boolean(),
  sendMail: z.boolean(),
});

const idParams = z.object({ id: z.string().uuid() });

export const announcementRoutes: FastifyPluginAsyncZod = async (app) => {
  /* -------------------------------------------------------------- the user */

  /**
   * What to show this person: the banner, the news list, and the unread count.
   *
   * One request rather than three, because the shell needs the banner and the
   * navigation needs the count on every page, and two round trips for one row
   * each is how a dashboard gains a second spinner.
   */
  app.get(
    "/announcements",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({
            banner: userAnnouncementSchema.nullable(),
            news: z.array(userAnnouncementSchema),
            unread: z.number().int(),
          }),
          401: errorResponseSchema,
        },
      },
    },
    async (request) => announcementsFor(request.userId!, app.db),
  );

  /** Dismissing a banner and reading a news item are the same act (D108). */
  app.post(
    "/announcements/:id/seen",
    {
      preHandler: app.requireAuth,
      schema: {
        params: idParams,
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const done = await markSeen(request.userId!, app.db, request.params.id);
      if (!done) return reply.code(404).send({ error: "not_found", message: "No such notice." });
      return { ok: true as const };
    },
  );

  /* ------------------------------------------------------------- the admin */

  app.get(
    "/admin/announcements",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({ announcements: z.array(announcementSchema) }),
          404: errorResponseSchema,
        },
      },
    },
    async () => ({ announcements: await listAnnouncements(app.db) }),
  );

  app.post(
    "/admin/announcements",
    {
      preHandler: app.requireAdmin,
      schema: {
        body: inputSchema,
        response: { 200: announcementSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      const created = await createAnnouncement(app.db, actor, request.body);
      // Queued, never sent here: D88's rule, and a publish that waited on SMTP
      // for every account would be the worst request in the app.
      if (created.published && created.sendMail) await mailAnnouncement(app.db, created.id);
      return created;
    },
  );

  app.put(
    "/admin/announcements/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        body: inputSchema,
        response: { 200: announcementSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const actor = await actorFor(app, request.userId!);
      const updated = await updateAnnouncement(app.db, actor, request.params.id, request.body);
      if (!updated) return reply.code(404).send({ error: "not_found", message: "No such notice." });

      if (updated.published && updated.sendMail) await mailAnnouncement(app.db, updated.id);
      return updated;
    },
  );

  app.delete(
    "/admin/announcements/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: {
          200: z.object({ ok: z.literal(true) }),
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = await actorFor(app, request.userId!);
      if (!(await deleteAnnouncement(app.db, actor, request.params.id))) {
        return reply.code(404).send({ error: "not_found", message: "No such notice." });
      }
      return { ok: true as const };
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
