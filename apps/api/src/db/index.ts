import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * The handle every repository takes.
 *
 * Deliberately the `PgDatabase` supertype rather than the concrete
 * `PostgresJsDatabase`, so a transaction handle satisfies it too. That is what
 * lets `register` run its insert-user / insert-profile / burn-invite sequence
 * inside one transaction while calling the same repository functions as
 * everything else.
 */
export type Db = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export function createDb(databaseUrl: string, options: { max?: number } = {}) {
  const client = postgres(databaseUrl, {
    max: options.max ?? 10,
    // Drizzle maps numeric columns to strings on purpose. Do not add a type
    // parser that turns them into floats — see CLAUDE.md §3 and shared/parse.ts.
  });
  const db = drizzle(client, { schema });
  return { db, client };
}

export { schema };
