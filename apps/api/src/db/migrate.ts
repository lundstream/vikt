/**
 * Applies every checked-in migration in `drizzle/`, then exits.
 *
 * Run by hand with `pnpm --filter api db:migrate`, and by the api container's
 * entrypoint before the server starts. Migrations are additive and checked in;
 * an applied migration is never edited (CLAUDE.md §7).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "../lib/dotenv.js";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db } from "./index.js";

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

/**
 * How many migrations this database has already recorded.
 *
 * Zero when the table does not exist yet, which is a fresh database rather than
 * an error. Read before and after so the run can **name what it applied**: the
 * migrator itself reports nothing, and one line saying "Migrations applied"
 * reads identically on a deploy that applied nine and one that applied none
 * (D149). On a deploy, which of those happened is the thing you want to know.
 */
async function recorded(database: Db): Promise<number> {
  try {
    const rows = (await database.execute(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    )) as unknown as { count: number }[];
    return Number(rows[0]?.count ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The migration names, in the order the migrator applies them.
 *
 * The recorded rows carry a hash and a timestamp, not a name, so the names come
 * from the journal and the count says how far down it this database is. The two
 * are in the same order by construction: the migrator walks the journal.
 */
function journalTags(): string[] {
  try {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
    ) as { entries?: { tag?: string }[] };
    return (journal.entries ?? []).map((entry) => entry.tag ?? "?");
  } catch {
    return [];
  }
}

try {
  const before = await recorded(db);
  await migrate(db, { migrationsFolder });
  const after = await recorded(db);

  for (const tag of journalTags().slice(before, after)) {
    process.stdout.write(`Migration applied: ${tag}\n`);
  }
  process.stdout.write(
    after === before
      ? `Migrations: none to apply, ${after} already recorded\n`
      : `Migrations: ${after - before} applied, ${after} recorded in total\n`,
  );
} catch (error) {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`);
  await client.end();
  process.exit(1);
}

await client.end();
