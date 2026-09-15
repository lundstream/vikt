/**
 * Times local food search against the database the API is configured for.
 *
 *   pnpm --filter api exec tsx src/scripts/measure-search.ts
 *
 * Local search only: `searchFoodItems`, never the adapters, so the figure is
 * the database's and not Open Food Facts'. Each query is run three times to
 * warm the cache and then twenty-five times, and the median and 90th
 * percentile are printed with the top three names, so a change to the ranking
 * can be judged on what it returns as well as on how long it takes
 * (docs/measurements.md, "Local food search").
 *
 * Read only. Nothing is written.
 */
import "../lib/dotenv.js";

import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { searchFoodItems } from "../repositories/food.repo.js";
import { users } from "../db/schema.js";

const QUERIES = [
  "banan",
  "kvarg",
  "ägg",
  "lindahls kvarg",
  "Yogghurt",
  "frischgöld",
  "köttbullar mammas",
  "mammas köttbullar",
  "zzzqqq",
];

const WARM = 3;
const RUNS = 25;

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

try {
  const versionRows = (await db.execute(sql`select version() as version`)) as unknown as {
    version: string;
  }[];
  const countRows = (await db.execute(
    sql`select count(*)::int as count from food_items`,
  )) as unknown as { count: number }[];
  const version = versionRows[0]?.version ?? "unknown";
  const count = countRows[0]?.count ?? 0;
  const [user] = await db.select({ id: users.id }).from(users).limit(1);
  if (!user) throw new Error("no user to search as");

  console.log(version.split(",")[0]);
  console.log(`food_items: ${count} rows; ${RUNS} runs per query after ${WARM} warm-up runs`);
  console.log("");
  console.log("query                 median   p90     top three");

  for (const query of QUERIES) {
    for (let i = 0; i < WARM; i += 1) await searchFoodItems(user.id, db, query, 12);

    const times: number[] = [];
    let names: string[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const start = performance.now();
      const rows = await searchFoodItems(user.id, db, query, 12);
      times.push(performance.now() - start);
      names = rows.slice(0, 3).map((row) => (row.brand ? `${row.brand} ${row.name}` : row.name));
    }
    times.sort((a, b) => a - b);

    console.log(
      `${JSON.stringify(query).padEnd(21)} ${quantile(times, 0.5).toFixed(1).padStart(5)} ms ` +
        `${quantile(times, 0.9).toFixed(1).padStart(5)} ms  ${names.join(" | ") || "(none)"}`,
    );
  }
} finally {
  await client.end();
}
