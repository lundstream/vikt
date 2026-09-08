import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema.js";
import "../src/lib/dotenv.js";

/**
 * The test database.
 *
 * A real Postgres, not a mock: the things most likely to be wrong here are the
 * `ON CONFLICT` clause, the unique indexes and the cascade behaviour, and none
 * of those exist in a fake. It is a *separate database* from development, so a
 * test run can never truncate real logs.
 *
 * `TEST_DATABASE_URL` overrides it. Otherwise the development `DATABASE_URL`
 * is reused with the database name swapped for `vikt_test`, which keeps the
 * credentials in one place.
 */
export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return explicit;

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Neither TEST_DATABASE_URL nor DATABASE_URL is set. Copy infra/.env.example to .env.",
    );
  }

  const url = new URL(base);
  const name = url.pathname.replace(/^\//, "") || "vikt";
  if (name.endsWith("_test")) return url.toString();
  url.pathname = `/${name}_test`;
  return url.toString();
}

/**
 * Creates the test database if it is not there yet, then migrates it.
 *
 * Memoised: the test files share one process, and re-migrating for each of them
 * is both slow and noisy.
 */
let prepared: Promise<string> | undefined;
export function prepareTestDatabase(): Promise<string> {
  prepared ??= doPrepare();
  return prepared;
}

/** Arbitrary; only has to agree between workers. */
const MIGRATION_LOCK = 8_461_207;

async function doPrepare(): Promise<string> {
  const url = testDatabaseUrl();
  const target = new URL(url);
  const databaseName = target.pathname.replace(/^\//, "");

  // Connect to the maintenance database to ask whether ours exists. CREATE
  // DATABASE cannot run inside a transaction, hence the separate connection.
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const adminClient = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await adminClient`
      select 1 from pg_database where datname = ${databaseName}
    `;
    if (rows.length === 0) {
      await adminClient.unsafe(`create database "${databaseName}"`);
    }
  } finally {
    await adminClient.end();
  }

  // `onnotice` off: the migrator emits "already exists, skipping" for the
  // drizzle bookkeeping tables on every run, which buries the test output.
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    /**
     * Vitest runs test files in parallel workers, each of which prepares the
     * database. Drizzle's migrator has no locking, so two workers both saw an
     * un-applied migration and both ran it: one won and the other died on
     * `column "search_vector" already exists`. `ADD COLUMN IF NOT EXISTS` does
     * not save you, because the existence check and the add are not atomic
     * across sessions.
     *
     * A session-level advisory lock serialises them. The number is arbitrary
     * and only has to be the same in every worker.
     */
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(drizzle(client, { schema }), { migrationsFolder: migrationsFolder() });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end();
  }

  return url;
}

function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../drizzle"),
    path.resolve(process.cwd(), "drizzle"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`No drizzle/ folder found. Looked in: ${candidates.join(", ")}`);
  return found;
}
