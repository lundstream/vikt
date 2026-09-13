/**
 * How much of the model's context one coach turn actually uses (D155).
 *
 * The sheet grew from a dozen aggregates to every domain over two windows plus
 * a week of meal names, and "it probably fits" is not a thing to deploy. This
 * asks the model itself: Ollama reports `prompt_eval_count` for the turn it was
 * given, and `/api/ps` reports the context the variant was loaded with, so the
 * margin is measured at both ends rather than estimated from characters.
 *
 * Talks to `/api/chat` directly rather than through `LlmClient`, because the
 * counts are the point and the client deliberately does not carry them: adding
 * them to the production path for the sake of a measurement would be the tail
 * wagging the dog.
 *
 * Run with `pnpm --filter api exec tsx src/scripts/coach-size.ts [email] [asOf]`.
 */
import "../lib/dotenv.js";
import { eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { users } from "../db/schema.js";
import {
  buildCoachFacts,
  CONTEXT_CHAR_BUDGET,
  CONTEXT_TURNS,
  FIGURE_UNITS,
} from "../llm/coach-context.js";
import { buildCoachPrompt } from "../llm/prompts/coach.js";

const email = process.argv[2] ?? "test@example.test";
const asOf = process.argv[3] ?? new Date().toISOString().slice(0, 10);

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
if (!user) throw new Error(`no account for ${email}`);

const facts = await buildCoachFacts(user.id, db, env, asOf);
const system = buildCoachPrompt("torr", facts.text);

/**
 * The worst turn this can be: a full question, the system prompt, and six past
 * turns of the length the model actually writes. The history is filled in with
 * a stand-in of that length rather than read from the database, because the
 * question is what the ceiling costs, not what today's conversation costs.
 */
const question =
  "Vad tror du om mitt upplägg, vad jag äter, hur viktnedgången ser ut? Något jag bör tänka på?";
const TYPICAL_REPLY_CHARS = 420;
const filler = "Detta är en tidigare replik i samtalet. ".repeat(
  Math.ceil(TYPICAL_REPLY_CHARS / 40),
);

const history = Array.from({ length: CONTEXT_TURNS }, (_, index) => ({
  role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
  content: filler,
}));

const messages = [
  { role: "system" as const, content: system },
  ...history,
  { role: "user" as const, content: question },
];

const chars = messages.reduce((sum, message) => sum + message.content.length, 0);

console.log(`sheet:        ${facts.chars} chars of a ${CONTEXT_CHAR_BUDGET} budget`);
console.log(`system:       ${system.length} chars`);
console.log(`whole turn:   ${chars} chars (system, ${CONTEXT_TURNS} past turns, the question)`);
for (const unit of FIGURE_UNITS) {
  const values = facts.figures[unit];
  if (values.length > 0) console.log(`  ${unit.padEnd(10)} ${values.join(", ")}`);
}

const started = Date.now();
const response = await fetch(`${env.OLLAMA_URL}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: env.OLLAMA_MODEL_LARGE,
    messages,
    stream: false,
    think: false,
    options: { temperature: 0.6 },
  }),
});

if (!response.ok) {
  console.log(`ollama said ${response.status}: ${await response.text()}`);
} else {
  const body = (await response.json()) as {
    prompt_eval_count?: number;
    eval_count?: number;
    message?: { content?: string };
  };

  const prompt = body.prompt_eval_count ?? 0;
  const reply = body.eval_count ?? 0;

  console.log("-".repeat(72));
  console.log(`prompt tokens: ${prompt}`);
  console.log(`reply tokens:  ${reply}`);
  console.log(`chars/token:   ${(chars / Math.max(1, prompt)).toFixed(2)}`);
  console.log(`took:          ${((Date.now() - started) / 1000).toFixed(1)} s`);

  /** What the variant was actually loaded with, which is the number that binds. */
  const ps = (await (await fetch(`${env.OLLAMA_URL}/api/ps`)).json()) as {
    models?: { name?: string; model?: string; context_length?: number }[];
  };
  const loaded = ps.models?.find(
    (entry) => entry.name === env.OLLAMA_MODEL_LARGE || entry.model === env.OLLAMA_MODEL_LARGE,
  );
  const numCtx = loaded?.context_length ?? null;

  console.log(`num_ctx:       ${numCtx ?? "not reported"}`);
  if (numCtx !== null) {
    console.log(`used:          ${((prompt + reply) / numCtx * 100).toFixed(1)} percent`);
    console.log(`margin:        ${numCtx - prompt - reply} tokens`);
  }
}

await client.end();
