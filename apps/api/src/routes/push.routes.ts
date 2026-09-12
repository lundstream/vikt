import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { and, desc, eq } from "drizzle-orm";
import { errorResponseSchema } from "shared";
import { pushSubscriptions } from "../db/schema.js";
import { pushEnabled, sendPush } from "../lib/push.js";
import { hostOf, payloadFor } from "../services/reminder.service.js";

/**
 * Push subscriptions, one row per device (D136).
 *
 * **Not registered at all without VAPID keys.** Push is absent rather than
 * degraded: a 404 from a path that does not exist is the same answer a private
 * install gives for the invite endpoint (D94), and for the same reason — a
 * route that answers 403 is still a route.
 *
 * Every handler is scoped by the session's `userId`. A subscription is a way to
 * reach a person, so reading or deleting somebody else's is the whole bug class
 * §3 exists to prevent.
 */

const subscriptionSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  /** Whether this row is the browser asking. Lets the screen say "den här". */
  current: z.boolean(),
});

export const pushRoutes: FastifyPluginAsyncZod = async (app) => {
  if (!pushEnabled(app.config)) return;

  /**
   * The public key, so the browser can subscribe.
   *
   * Behind a session rather than public: it is not a secret, but an anonymous
   * caller has no use for it, and an endpoint that answers before sign-in is an
   * endpoint somebody has to think about.
   */
  app.get(
    "/push/key",
    {
      preHandler: app.requireAuth,
      schema: { response: { 200: z.object({ publicKey: z.string() }) } },
    },
    async () => ({ publicKey: app.config.VAPID_PUBLIC_KEY.trim() }),
  );

  /**
   * Subscribing, or re-subscribing the same browser.
   *
   * `ON CONFLICT (endpoint)` updates rather than inserting, because the
   * endpoint **is** the device: a browser that re-subscribes after clearing
   * data or reinstalling produces the same row rather than a second one that
   * fires alongside the first. The keys are updated with it, since a
   * re-subscription usually means they changed.
   */
  app.post(
    "/push/subscribe",
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.object({
          endpoint: z.string().url().max(2000),
          p256dh: z.string().min(1).max(500),
          auth: z.string().min(1).max(500),
          /** What the browser calls itself. Editable afterwards, per D56. */
          label: z.string().trim().max(120).optional(),
        }),
        response: { 200: z.object({ id: z.string().uuid() }) },
      },
    },
    async (request) => {
      const userId = request.userId!;
      const values = {
        userId,
        endpoint: request.body.endpoint,
        p256dh: request.body.p256dh,
        auth: request.body.auth,
        label: request.body.label ?? "",
        lastSeenAt: new Date(),
      };

      const [row] = await app.db
        .insert(pushSubscriptions)
        .values(values)
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          /**
           * `userId` is updated too. A shared computer where one account signs
           * out and another signs in produces the same endpoint for a different
           * person, and the row has to follow, or the first account keeps
           * receiving reminders on a browser that is no longer theirs.
           */
          set: values,
        })
        .returning({ id: pushSubscriptions.id });

      return { id: row!.id };
    },
  );

  /** This account's devices, newest first. */
  app.get(
    "/push/subscriptions",
    {
      preHandler: app.requireAuth,
      schema: {
        querystring: z.object({ endpoint: z.string().max(2000).optional() }),
        response: { 200: z.object({ subscriptions: z.array(subscriptionSchema) }) },
      },
    },
    async (request) => {
      const rows = await app.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, request.userId!))
        .orderBy(desc(pushSubscriptions.createdAt));

      return {
        subscriptions: rows.map((row) => ({
          id: row.id,
          label: row.label,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          current: request.query.endpoint !== undefined && row.endpoint === request.query.endpoint,
        })),
      };
    },
  );

  /** Renaming a device (D56). "Min telefon" beats a 200-character endpoint. */
  app.patch(
    "/push/subscriptions/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ label: z.string().trim().max(120) }),
        response: { 200: z.object({ ok: z.literal(true) }), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const updated = await app.db
        .update(pushSubscriptions)
        .set({ label: request.body.label })
        .where(
          and(
            eq(pushSubscriptions.id, request.params.id),
            eq(pushSubscriptions.userId, request.userId!),
          ),
        )
        .returning({ id: pushSubscriptions.id });

      if (updated.length === 0) {
        return reply.code(404).send({ error: "not_found", message: "Ingen sådan enhet." });
      }
      return { ok: true as const };
    },
  );

  /**
   * Removing a device (D56).
   *
   * From **any** device, which is the point: the commonest reason to want this
   * is a phone somebody no longer has, and a control that only works on the
   * device being removed would be useless in exactly that case.
   */
  app.delete(
    "/push/subscriptions/:id",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const removed = await app.db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.id, request.params.id),
            eq(pushSubscriptions.userId, request.userId!),
          ),
        )
        .returning({ id: pushSubscriptions.id });

      if (removed.length === 0) {
        return reply.code(404).send({ error: "not_found", message: "Ingen sådan enhet." });
      }
      return { ok: true as const };
    },
  );

  /**
   * "Skicka en testnotis".
   *
   * So somebody can find out that this device works **before** trusting it with
   * tomorrow morning. Without it the first test of the whole arrangement is a
   * reminder that does not arrive, and the person has no way to tell whether
   * the app is broken or they are not due one.
   *
   * Reports what happened per device rather than a bare ok: "sent to 1 of 2"
   * is the answer when an old subscription has expired, and the expired one is
   * removed on the spot, exactly as a real send would.
   */
  app.post(
    "/push/test",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({
            devices: z.number().int().min(0),
            sent: z.number().int().min(0),
            removed: z.number().int().min(0),
          }),
        },
      },
    },
    async (request) => {
      const rows = await app.db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, request.userId!));

      let sent = 0;
      let removed = 0;
      let unauthorized = 0;

      for (const row of rows) {
        const outcome = await sendPush(
          { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
          { ...payloadFor("weigh"), body: "Testnotis från Vikt", tag: "vikt-test" },
        );

        if (outcome.status === "sent") {
          sent += 1;
          await app.db
            .update(pushSubscriptions)
            .set({ lastSeenAt: new Date() })
            .where(eq(pushSubscriptions.id, row.id));
          continue;
        }

        if (outcome.status === "gone") {
          removed += 1;
          await app.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
          request.log.info(
            { subscription: row.id, host: hostOf(row.endpoint), reason: outcome.reason },
            "push subscription removed",
          );
          continue;
        }

        // 403 keeps the row. Counted here so the one warning below can be
        // written once for the whole request rather than once per device.
        if (outcome.status === "unauthorized") unauthorized += 1;
      }

      if (unauthorized > 0) {
        request.log.warn(
          { unauthorized },
          "push rejected the signature (403) and no subscription was removed. " +
            "Check the VAPID pair and that VAPID_SUBJECT is a mailto: address or a URL",
        );
      }

      return { devices: rows.length, sent, removed };
    },
  );
};
