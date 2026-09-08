import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "shared";
import { readWorkerState } from "../mail/drainer.js";
import {
  approveInviteRequest,
  deleteInviteRequest,
  listInviteRequests,
  rejectInviteRequest,
} from "../services/invite-request.service.js";
import { listMail } from "../mail/queue.js";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.js";
import {
  deleteUser,
  listAdminLog,
  listInvites,
  listUsers,
  mintInviteAs,
  previewDeletion,
  resetForUser,
  retryMail,
  revokeInvite,
  setUserDisabled,
} from "../services/admin.service.js";
import { notFound } from "../lib/errors.js";

/**
 * The admin view (D89).
 *
 * Two lists and three actions: pending invite requests, the outbound mail
 * queue, and approve, reject or delete. Everything behind `requireAdmin`, which
 * is `requireAuth` plus one question and answers 404 rather than 403 — a
 * non-admin has no business learning that these endpoints exist.
 *
 * The mail list is here rather than in a log because §3's honesty rule applies
 * to the app's own failures too: a send that never happened has to be visible
 * to the person who could do something about it.
 */

const requestSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  /** What the requester called themselves, or nothing on a row from before D112. */
  name: z.string().nullable(),
  reason: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /** Shown again after approval, which is the fallback when mail is off. */
  inviteCode: z.string().nullable(),
});

const mailSchema = z.object({
  id: z.string().uuid(),
  toAddress: z.string(),
  template: z.string(),
  subject: z.string(),
  status: z.string(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
});

const idParams = z.object({ id: z.string().uuid() });

const adminUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  isAdmin: z.boolean(),
});

const deletionPreviewSchema = z.object({
  email: z.string(),
  weights: z.number().int(),
  foodEntries: z.number().int(),
  dailyLogs: z.number().int(),
  photos: z.number().int(),
});

const okSchema = z.object({ ok: z.literal(true) });

/**
 * Who is acting, for the audit log (D95).
 *
 * Read per request rather than carried on the request object, because the log
 * needs the address as well as the id and the address is what keeps the row
 * readable after the account is gone.
 */
async function actorFor(app: Parameters<FastifyPluginAsyncZod>[0], userId: string) {
  const [row] = await app.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row!;
}

export const adminRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/admin/invite-requests",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            requests: z.array(requestSchema),
            /** So the screen can say whether approving will send anything. */
            mailEnabled: z.boolean(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async () => ({
      requests: (await listInviteRequests(app.db)).map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        reason: row.reason,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
        inviteCode: row.inviteCode,
      })),
      mailEnabled: app.mailer.enabled,
    }),
  );

  app.get(
    "/admin/mail",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            mail: z.array(mailSchema),
            /**
             * Whether anything is draining the queue (D104).
             *
             * Null means no worker has ever ticked, which is the state that
             * looked identical to "waiting its turn" for the hour two invite
             * mails sat unsent.
             */
            worker: z
              .object({
                lastTickAt: z.string(),
                sentSinceStart: z.number().int(),
                lastError: z.string().nullable(),
              })
              .nullable(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async () => ({
      worker: await readWorkerState(app.db),
      mail: (await listMail(app.db)).map((row) => ({
        id: row.id,
        toAddress: row.toAddress,
        template: row.template,
        subject: row.subject,
        status: row.status,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt?.toISOString() ?? null,
      })),
    }),
  );

  /**
   * Approving mints a code and queues the mail.
   *
   * `emailed: false` means mail is off and the code is the screen's
   * responsibility to show. That is the whole degraded path: the owner reads it
   * and passes it on by hand, and nothing about the approval is lost.
   */
  app.post(
    "/admin/invite-requests/:id/approve",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: {
          200: z.object({ code: z.string(), emailed: z.boolean() }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const result = await approveInviteRequest(
        app.db,
        app.config,
        request.params.id,
        request.userId!,
        app.mailer.enabled,
      );
      if (!result.ok) throw notFound("No such request.");
      return { code: result.code, emailed: result.emailed };
    },
  );

  /** Rejecting deletes the row and sends nothing. */
  app.post(
    "/admin/invite-requests/:id/reject",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: {
          200: z.object({ deleted: z.literal(true) }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      if (!(await rejectInviteRequest(app.db, request.params.id))) {
        throw notFound("No such request.");
      }
      return { deleted: true as const };
    },
  );

  /** An approved row, once the owner is done with it. */
  app.delete(
    "/admin/invite-requests/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: {
          200: z.object({ deleted: z.literal(true) }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      if (!(await deleteInviteRequest(app.db, request.params.id))) {
        throw notFound("No such request.");
      }
      return { deleted: true as const };
    },
  );
  /* ---------------------------------------------------------------- users */

  app.get(
    "/admin/users",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({ users: z.array(adminUserSchema) }),
          404: errorResponseSchema,
        },
      },
    },
    async () => ({ users: await listUsers(app.db) }),
  );

  app.post(
    "/admin/users/:id/disabled",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        body: z.object({ disabled: z.boolean() }),
        response: { 200: okSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      const done = await setUserDisabled(
        app.db,
        actor,
        request.params.id,
        request.body.disabled,
      );
      if (!done) throw notFound("No such account.");
      return { ok: true as const };
    },
  );

  /**
   * What a delete would remove, before anyone confirms it.
   *
   * A separate read rather than a confirmation dialog's guess: the numbers come
   * from the same tables the cascade will empty, so what the admin is shown is
   * what will actually go.
   */
  app.get(
    "/admin/users/:id/deletion",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: { 200: deletionPreviewSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const preview = await previewDeletion(app.db, request.params.id);
      if (!preview) throw notFound("No such account.");
      return preview;
    },
  );

  app.delete(
    "/admin/users/:id",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: { 200: deletionPreviewSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      const removed = await deleteUser(app.db, actor, request.params.id);
      if (!removed) throw notFound("No such account.");
      return removed;
    },
  );

  /** A reset link on someone's behalf. The admin never sees a password. */
  app.post(
    "/admin/users/:id/reset",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: {
          200: z.object({ ok: z.literal(true), emailed: z.boolean() }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      const done = await resetForUser(app.db, app.config, actor, request.params.id);
      if (!done) throw notFound("No such account.");
      return { ok: true as const, emailed: app.mailer.enabled };
    },
  );

  /* -------------------------------------------------------------- invites */

  app.get(
    "/admin/invites",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            invites: z.array(
              z.object({
                code: z.string(),
                createdAt: z.string(),
                usedAt: z.string().nullable(),
                expiresAt: z.string().nullable(),
              }),
            ),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async () => ({ invites: await listInvites(app.db) }),
  );

  app.post(
    "/admin/invites",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({ code: z.string() }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      return { code: await mintInviteAs(app.db, actor) };
    },
  );

  /** Only an unused code. A used one explains an account that exists. */
  app.delete(
    "/admin/invites/:code",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: z.object({ code: z.string().min(1).max(64) }),
        response: { 200: okSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      if (!(await revokeInvite(app.db, actor, request.params.code))) {
        throw notFound("No such unused code.");
      }
      return { ok: true as const };
    },
  );

  /* ----------------------------------------------------------------- mail */

  app.post(
    "/admin/mail/:id/retry",
    {
      preHandler: app.requireAdmin,
      schema: {
        params: idParams,
        response: { 200: okSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      if (!(await retryMail(app.db, actor, request.params.id))) {
        throw notFound("No such message.");
      }
      return { ok: true as const };
    },
  );

  /* ------------------------------------------------------------------ log */

  app.get(
    "/admin/log",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            entries: z.array(
              z.object({
                id: z.string().uuid(),
                actorEmail: z.string(),
                action: z.string(),
                subject: z.string().nullable(),
                detail: z.string().nullable(),
                createdAt: z.string(),
              }),
            ),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async () => ({ entries: await listAdminLog(app.db) }),
  );
};
