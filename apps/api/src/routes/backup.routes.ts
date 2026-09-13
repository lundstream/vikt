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
  testBackupDestination,
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
              s3Endpoint: z.string(),
              s3Region: z.string(),
              s3Bucket: z.string(),
              s3PathStyle: z.boolean(),
              s3AccessKeyId: z.string(),
              /**
               * Whether a secret key is stored and readable, never the secret
               * (D133). The screen has to be able to say "a secret is set" and
               * "the stored one cannot be read with this key"; neither of those
               * needs the value, and an endpoint that returned it would put it
               * in every browser cache that touched this screen.
               */
              s3SecretSet: z.boolean(),
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
          s3Endpoint: z.string().trim().max(500).optional(),
          s3Region: z.string().trim().max(64).optional(),
          s3Bucket: z.string().trim().max(255).optional(),
          s3PathStyle: z.boolean().optional(),
          s3AccessKeyId: z.string().trim().max(255).optional(),
          /**
           * Absent leaves the stored secret alone; an explicit empty string
           * clears it (D133). The screen never receives the secret, so it
           * cannot send it back, and reading an absent field as "clear it"
           * would wipe the secret every time somebody changed the schedule.
           */
          s3SecretAccessKey: z.string().max(255).optional(),
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
            result.reason === "no_secret_key"
              ? "SECRET_KEY is not set, so the share password cannot be stored encrypted. " +
                "It is refused rather than saved in the clear or quietly dropped."
              : "Only local and S3 destinations are implemented. Writing to a Windows " +
                "share directly is not: both Node SMB clients speak NTLMv1, which " +
                "current servers refuse. Mount the share on the host and choose a " +
                "directory destination instead.",
        });
      }
      return { ok: true as const };
    },
  );

  /**
   * Write a probe file to the destination and delete it again (D130).
   *
   * The one question an admin cannot answer any other way: whether the host,
   * share, folder, username and password are, together, a place this process
   * can write. Every one of them can be individually plausible and collectively
   * wrong, and the alternative to this button is finding out from a failed run
   * at three in the morning.
   *
   * A separate endpoint rather than a flag on the save, because it is worth
   * pressing without changing anything: a share that worked last month and does
   * not today is a thing to be able to check.
   */
  app.post(
    "/admin/backup/test",
    {
      preHandler: app.requireAdmin,
      schema: {
        response: {
          200: z.object({
            ok: z.boolean(),
            /** The probe's file name when it worked, so the log line matches. */
            wrote: z.string().nullable(),
            reason: z.string().nullable(),
          }),
          404: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const actor = await actorFor(app, request.userId!);
      const outcome = await testBackupDestination(app.db, actor);

      return outcome.ok
        ? { ok: true, wrote: outcome.wrote, reason: null }
        : { ok: false, wrote: null, reason: outcome.reason };
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
