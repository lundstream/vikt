/**
 * One real turn against the real model, printed in full.
 *
 * What this is for: §6 phase 8b asks for a live turn "reported verbatim so the
 * voice can be judged", and the guardrail work needs the same thing from the
 * other side — when a reply is refused, somebody has to be able to see which
 * figure did it and decide whether the model invented a number or the check is
 * too tight. Both questions are unanswerable from the SSE stream alone, which
 * deliberately carries no refused text.
 *
 * Prints the context block and its size too, which is the record the phase asks
 * for: the block has to fit the saved variant's `num_ctx` with room for a reply.
 *
 * Run with `pnpm --filter api exec tsx src/scripts/coach-probe.ts "<question>"`.
 */
import "../lib/dotenv.js";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { users } from "../db/schema.js";
import { createLlmClient } from "../llm/client.js";
import { buildCoachFacts, CONTEXT_CHAR_BUDGET } from "../llm/coach-context.js";
import { checkSentence, sentencesOf } from "../llm/coach-guard.js";
import { COACH_PERSONA, NO_PRESCRIPTION } from "../llm/prompts/coach.js";

const question = process.argv[2] ?? "Hur har veckan sett ut?";
const email = process.argv[3] ?? "test@example.test";
const asOf = process.argv[4] ?? new Date().toISOString().slice(0, 10);

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

const [user] = await db.select().from(users).where(and(eq(users.email, email))).limit(1);
if (!user) throw new Error(`no account for ${email}`);

const facts = await buildCoachFacts(user.id, db, env, asOf);

console.log("=".repeat(72));
console.log("CONTEXT, verbatim");
console.log("=".repeat(72));
console.log(facts.text);
console.log("-".repeat(72));
console.log(`chars: ${facts.chars} of a ${CONTEXT_CHAR_BUDGET} budget`);
console.log(`figures kcal: ${facts.figures.kcal.join(", ")}`);
console.log(`figures kg: ${facts.figures.kg.join(", ")}`);
console.log(`figures kg/vecka: ${facts.figures.kgPerWeek.join(", ")}`);
console.log(`figures procent: ${facts.figures.percent.join(", ")}`);
console.log(`floor: ${facts.guardrails.intakeFloorKcal}, max rate: ${facts.guardrails.maxRateKgWeek}`);

const llm = createLlmClient(env);

const result = await llm.chat({
  model: env.OLLAMA_MODEL_LARGE,
  messages: [
    {
      role: "system",
      content: [
        COACH_PERSONA,
        NO_PRESCRIPTION,
        "Du svarar bara utifrån siffrorna nedan och utifrån NNR. Du hittar aldrig på ett tal. " +
          "Om någon frågar hur mycket kalorier eller makron en maträtt har, svarar du att det står under Mat, " +
          "där siffrorna kommer från databasen. Du loggar ingenting och ändrar ingenting: du kan bara berätta " +
          "var i appen något görs.",
        "Det här är vad appen vet om personen just nu:",
        facts.text,
      ].join("\n\n"),
    },
    { role: "user", content: question },
  ],
  timeoutMs: env.OLLAMA_JOB_TIMEOUT_MS,
  temperature: 0.6,
});

console.log("=".repeat(72));
console.log(`QUESTION: ${question}`);
console.log("=".repeat(72));

if (!result.ok) {
  console.log(`no answer: ${result.reason} ${result.detail ?? ""}`);
} else {
  console.log(result.content);
  console.log("-".repeat(72));
  console.log(`model: ${result.model}, ${result.ms} ms, ${result.content.length} chars`);
  console.log("-".repeat(72));

  for (const sentence of sentencesOf(result.content)) {
    const verdict = checkSentence(sentence, facts);
    console.log(
      verdict.ok ? `PASS  ${sentence}` : `REFUSE [${verdict.reason}: ${verdict.detail}] ${sentence}`,
    );
  }
}

await client.end();
