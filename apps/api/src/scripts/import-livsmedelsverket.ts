/**
 * Imports Livsmedelsverket's livsmedelsdatabas into `food_items`.
 *
 *   pnpm --filter api import:livsmedelsverket
 *   pnpm --filter api import:livsmedelsverket --limit 50        # a sample
 *
 * Their API has no working name filter and keeps nutrients behind a per-food
 * link, so live search would be one request per result (see the note in
 * `food/livsmedelsverket.ts`). It is a static reference table of about 2600
 * generic Swedish foods, so it is imported once and searched locally — which
 * also makes staples instant and available offline.
 *
 * Re-runnable. `upsertFoodItem` conflicts on `(source, source_ref)`, so a second
 * run refreshes rather than duplicating.
 */
import "../lib/dotenv.js";
import { parseArgs } from "node:util";
import { cliArgs } from "./args.js";
import { toNumeric, toNumericOrNull } from "shared";
import { createDb, type Db } from "../db/index.js";
import { LivsmedelsverketAdapter, normaliseLivsmedel } from "../food/livsmedelsverket.js";
import { RateLimiter } from "../food/rate-limit.js";
import { upsertFoodItem } from "../repositories/food.repo.js";

const { values } = parseArgs({
  args: cliArgs(),
  options: {
    limit: { type: "string" },
    "page-size": { type: "string", default: "100" },
  },
  // pnpm forwards its own `--` separator, which parseArgs otherwise rejects.
  allowPositionals: true,
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not set.\n");
  process.exit(1);
}

const pageSize = Math.min(Number(values["page-size"]) || 100, 200);
const hardLimit = values.limit ? Number(values.limit) : Infinity;

const { db, client } = createDb(databaseUrl, { max: 2 });

/**
 * The adapter's default limiter gives up after eight seconds of queueing, which
 * is correct for a person scanning a barcode in a shop — nobody stands there for
 * three minutes — and wrong here. This import is 2606 nutrient requests at 60 a
 * minute, so **every** call after the first minute is a legitimate wait. The
 * queue deadline is raised rather than the rate: politeness to their servers is
 * the point of the limiter, and the request rate is unchanged.
 */
const adapter = new LivsmedelsverketAdapter({
  limiter: new RateLimiter({ limit: 60, maxQueueMs: 10 * 60_000 }),
});

let imported = 0;
let skipped = 0;
const reasons = new Map<string, number>();

/**
 * `food_items` is a shared cache, and these rows belong to nobody. The repo
 * function takes a `userId` for its scoping convention; the imported rows are
 * `visibility: "shared"` with a null creator, so the value is not read.
 */
const IMPORTER = "00000000-0000-0000-0000-000000000000";

async function importOne(
  database: Db,
  food: { nummer: string; namn: string },
): Promise<void> {
  let nutrients: Record<string, unknown>[];
  try {
    nutrients = await adapter.fetchNutrients(food.nummer);
  } catch (error) {
    // One food timing out must not discard the two thousand already imported.
    // The upsert is idempotent, so re-running picks the stragglers up.
    skipped += 1;
    const reason = `fetch failed: ${(error as Error).message}`;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    return;
  }

  const result = normaliseLivsmedel(food, nutrients);

  if (!result.ok) {
    skipped += 1;
    reasons.set(result.failure.reason, (reasons.get(result.failure.reason) ?? 0) + 1);
    return;
  }

  await upsertFoodItem(IMPORTER, database, {
    source: "livsmedelsverket",
    sourceRef: result.food.sourceRef,
    barcode: null,
    name: result.food.name,
    brand: null,
    createdBy: null,
    visibility: "shared",
    kcalPer100: toNumeric(result.food.kcalPer100, 2),
    proteinPer100: toNumericOrNull(result.food.macros.proteinG, 2),
    carbsPer100: toNumericOrNull(result.food.macros.carbsG, 2),
    fatPer100: toNumericOrNull(result.food.macros.fatG, 2),
    fiberPer100: toNumericOrNull(result.food.macros.fiberG, 2),
    saltPer100: toNumericOrNull(result.food.macros.saltG, 2),
    servingHints: null,
  });
  imported += 1;
}

try {
  const first = await adapter.listFoods(0, 1);
  const total = Math.min(first.total, hardLimit);
  process.stdout.write(`Livsmedelsverket has ${first.total} foods; importing ${total}.\n`);

  for (let offset = 0; offset < total; offset += pageSize) {
    const { foods } = await adapter.listFoods(offset, Math.min(pageSize, total - offset));
    if (foods.length === 0) break;

    for (const food of foods) {
      if (imported + skipped >= total) break;
      await importOne(db, food);
    }

    process.stdout.write(
      `  ${imported + skipped}/${total} — ${imported} imported, ${skipped} skipped\n`,
    );
  }
} catch (error) {
  process.stderr.write(`\nImport failed: ${(error as Error).message}\n`);
  await client.end();
  process.exit(1);
}

process.stdout.write(`\nDone. ${imported} imported, ${skipped} skipped.\n`);
if (reasons.size > 0) {
  process.stdout.write("Skipped because:\n");
  for (const [reason, count] of reasons) process.stdout.write(`  ${reason}: ${count}\n`);
}

await client.end();
