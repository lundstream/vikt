/**
 * One Sunday sweep against the development database, with the real model.
 *
 * Counts what it cost: **queries**, through the driver's own debug hook, and
 * **generations**, by wrapping the client. The second run inside the same window
 * is supposed to be cheap, and "supposed to be" is not a measurement.
 *
 * Run with `pnpm --filter api exec tsx src/scripts/review-sweep-probe.ts <iso>`,
 * where the instant is the Sunday evening to sweep as of.
 */
import "../lib/dotenv.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import { loadEnv } from "../env.js";
import { createLlmClient, type ChatOptions, type ChatResult, type LlmClient } from "../llm/client.js";
import { runWeeklyReviews } from "../services/review.service.js";

const now = process.argv[2] ? new Date(process.argv[2]) : new Date();
const env = loadEnv();

/* ------------------------------------------------------- counting the cost */

const queries: string[] = [];
const client = postgres(env.DATABASE_URL, {
  max: 4,
  // The driver hands every statement to this before sending it.
  debug: (_connection, query) => queries.push(query.replace(/\s+/g, " ").slice(0, 120)),
});
const db = drizzle(client, { schema });

const real = createLlmClient(env);
let generations = 0;
const counting: LlmClient = {
  enabled: real.enabled,
  reachable: () => real.reachable(),
  chat: (options: ChatOptions): Promise<ChatResult> => {
    generations += 1;
    return real.chat(options);
  },
  chatStream: (options, onDelta) => {
    generations += 1;
    return real.chatStream(options, onDelta);
  },
};

console.log(`sweeping as of ${now.toISOString()}`);
console.log(`llm enabled: ${counting.enabled}, reachable: ${await counting.reachable()}`);

queries.length = 0;
const started = Date.now();
const result = await runWeeklyReviews(db, env, counting, now);

console.log(`result: ${JSON.stringify(result)}`);
console.log(`generations: ${generations}`);
console.log(`queries: ${queries.length}`);
for (const query of queries) console.log(`  ${query}`);
console.log(`took ${Date.now() - started} ms`);

await client.end();
