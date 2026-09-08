/**
 * Applies every checked-in migration in `drizzle/`, then exits.
 *
 * Run by hand with `pnpm --filter api db:migrate`, and by the api container's
 * entrypoint before the server starts. Migrations are additive and checked in;
 * an applied migration is never edited (CLAUDE.md §7).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "../lib/dotenv.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./index.js";

/**
 * `drizzle/` sits at the api package root. This file runs from `src/db/` under
 * tsx and from `dist/` after a tsup build, so try both before falling back to
 * the working directory.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder =
  [
    path.resolve(here, "../../drizzle"),
    path.resolve(here, "../drizzle"),
    path.resolve(process.cwd(), "drizzle"),
  ].find((candidate) => existsSync(candidate)) ?? path.resolve(here, "../../drizzle");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not set.\n");
  process.exit(1);
}

const { db, client } = createDb(databaseUrl, { max: 1 });

try {
  await migrate(db, { migrationsFolder });
  process.stdout.write(`Migrations applied from ${migrationsFolder}\n`);
} catch (error) {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`);
  await client.end();
  process.exit(1);
}

await client.end();
