import { createReadStream } from "node:fs";
import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { errorResponseSchema } from "shared";
import { adminLog, users } from "../db/schema.js";
import { secretsAvailable } from "../lib/secrets.js";
import {
  latestBackupFile,
  listBackupRuns,
  nextRunAt,
  readBackupSettings,
  runBackup,
  writeBackupSettings,
} from "../services/backup.service.js";

/**
 * Backups, from the admin screen (D103).
 *
 * Behind `requireAdmin`, which answers 404 rather than 403. There is no restore
 * endpoint and there will not be one: restoring is the operation that destroys a
 * live database by succeeding, and it stays a documented command somebody has to
 * type.
 */

const runSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "ok", "failed"]),
  startedByEmail: z.string().nullable(),
  destination: z.string(),
  fileName: z.string().nullable(),
  bytes: z.number().nullable(),
  error: z.string().nullable(),
});

export const backupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/admin/backup",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            settings: z.object({
              destinationKind: z.enum(["local", "smb", "s3"]),
              destinationPath: z.string(),
              scheduleMinute: z.number().int().nullable(),
              retainDays: z.number().int(),
              updatedAt: z.string().nullable(),
              updatedByEmail: z.string().nullable(),
            }),
            runs: z.array(runSchema),
            nextRunAt: z.string().nullable(),
            /** Without it nothing can be written, and the screen must say so. */
            secretKeyPresent: z.boolean(),
            /** Whether there is a file the download would actually send. */
            downloadable: z.boolean(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async () => {
      const settings = await readBackupSettings(app.db);
      return {
        settings,
        runs: await listBackupRuns(app.db),
        nextRunAt: nextRunAt(settings.scheduleMinute)?.toISOString() ?? null,
        secretKeyPresent: secretsAvailable(),
        downloadable: (await latestBackupFile(app.db)) !== null,
      };
    },
  );

  app.put(
    "/admin/backup",
    {
      preHandler: app.requireAdmin,
      schema: {
        body: z.object({
          destinationKind: z.enum(["local", "smb", "s3"]),
          destinationPath: z.string().max(1000),
          /** Minutes past midnight, or null for no schedule. */
          scheduleMinute: z.number().int().min(0).max(1439).nullable(),
          retainDays: z.number().int().min(1).max(3650),
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          422: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const actor = await actorFor(app, request.userId!);
      const result = await writeBackupSettings(app.db, actor, request.body);

      if (!result.ok) {
        return reply.code(422).send({
          error: result.reason,
          message:
            "Only a local destination is implemented. SMB and S3 are named in the " +
            "settings but not built, and this refuses rather than silently doing nothing.",
        });
      }
      return { ok: true as const };
    },
  );

  /**
   * Run one now.
   *
   * Inside the request, and it can take a while. That is the honest shape: an
   * admin pressing "run now" is asking to wait for the answer, and a queued run
   * whose result appears somewhere else later is the thing that makes people
   * press a button twice.
   */
  app.post(
    "/admin/backup/run",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            ok: z.boolean(),
            fileName: z.string().nullable(),
            bytes: z.number().nullable(),
            reason: z.string().nullable(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      const outcome = await runBackup(app.db, app.config, actor);

      return outcome.ok
        ? { ok: true, fileName: outcome.fileName, bytes: outcome.bytes, reason: null }
        : { ok: false, fileName: null, bytes: null, reason: outcome.reason };
    },
  );

  /**
   * Download the newest backup.
   *
   * Admin only, and **logged**, because this is the one endpoint that hands a
   * copy of every user's data to a browser. The file is encrypted, so what
   * leaves is unreadable without `SECRET_KEY`, which is the property that makes
   * offering it at all reasonable.
   */
  app.get(
    "/admin/backup/latest",
    {
      preHandler: app.requireAdmin,
      /*
        No response schema. This sends a file, and the Zod serialiser narrows a
        declared response to the shape it declares, so a `ReadStream` stops
        typechecking against it. The export routes hit exactly this in D96.
      */
      schema: {},
    },
    async (request, reply) => {
      const file = await latestBackupFile(app.db);
      if (!file) return reply.code(404).send({ error: "not_found", message: "No backup yet." });

      const actor = await actorFor(app, request.userId!);
      await app.db.insert(adminLog).values({
        actorId: actor.id,
        actorEmail: actor.email,
        action: "backup.download",
        subject: file.fileName,
        detail: null,
      });

      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
        .send(createReadStream(file.path));
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
