import { Readable } from "node:stream";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { errorResponseSchema } from "shared";
import {
  csvFor,
  exportUser,
  EXPORTED_TABLES,
  type ExportedTable,
} from "../services/export.service.js";
import { importUser } from "../services/import.service.js";
import { badRequest, unprocessable } from "../lib/errors.js";

/**
 * Taking your data with you (D96).
 *
 * Reachable from the app rather than only by an admin, because with other
 * people's accounts on this server it is their data portability and not just
 * the owner's backup convenience.
 *
 * Every route is `requireAuth` and scoped to `request.userId`. There is no
 * admin route that exports somebody else's account: an admin can already read
 * the database, and an endpoint that hands one person's complete history to
 * another over HTTP is a much larger thing than an admin who can run a query.
 */
export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Everything, as one JSON file. The format the import reads. */
  app.get(
    "/export/json",
    {
      preHandler: app.requireAuth,
      /**
       * No response schema: this sends a file, not a JSON body the type
       * provider can narrow. The 401 still comes from `requireAuth`.
       */
    },
    async (request, reply) => {
      const data = await exportUser(request.userId!, app.db);
      const stamp = data.exportedAt.slice(0, 10);
      return reply
        .header("content-type", "application/json; charset=utf-8")
        .header("content-disposition", `attachment; filename="vikt-${stamp}.json"`)
        .send(JSON.stringify(data, null, 2));
    },
  );

  /**
   * One table as CSV, streamed.
   *
   * Streamed because an export is unbounded: a few years of food entries is
   * tens of thousands of rows, and building the file in memory to hand to the
   * reply is how a small server runs out of it.
   */
  app.get(
    "/export/csv/:table",
    {
      preHandler: app.requireAuth,
      schema: {
        params: z.object({ table: z.string() }),
      },
    },
    async (request, reply) => {
      const table = request.params.table as ExportedTable;
      if (!(EXPORTED_TABLES as readonly string[]).includes(table)) {
        throw badRequest("unknown_table", "There is no such table in an export.");
      }

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="vikt-${table}.csv"`)
        /**
         * Wrapped in a Readable rather than handed over as a generator:
         * Fastify serialises anything it is given that is not a stream or a
         * buffer, and an async generator serialises to `{}`.
         */
        .send(Readable.from(csvFor(request.userId!, app.db, table)));
    },
  );

  /** What a CSV export contains, so a screen can offer them without a hard-coded list. */
  app.get(
    "/export/tables",
    {
      preHandler: app.requireAuth,
      schema: {
        response: {
          200: z.object({ tables: z.array(z.string()) }),
          401: errorResponseSchema,
        },
      },
    },
    async () => ({ tables: [...EXPORTED_TABLES] }),
  );

  /**
   * Reading an export back into an **empty** account.
   *
   * Refuses otherwise rather than merging: which weight wins for a day both
   * files have, and what happens to two active plans, are real questions with
   * real answers, and none of them need answering to restore an account.
   */
  app.post(
    "/import/json",
    {
      preHandler: app.requireAuth,
      schema: {
        body: z.unknown(),
        response: {
          200: z.object({ rows: z.number().int() }),
          401: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const outcome = await importUser(request.userId!, app.db, request.body);

      if (!outcome.ok) {
        const message =
          outcome.reason === "account_not_empty"
            ? "Kontot innehåller redan data. En import läser bara in i ett tomt konto."
            : "Filen är inte en export från Vikt.";
        throw unprocessable(outcome.reason, message);
      }

      return { rows: outcome.rows };
    },
  );
};
