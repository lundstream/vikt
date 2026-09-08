/**
 * Runs the real parsing prompt against the real model, and applies the same
 * reader the API uses.
 *
 * A manual check, not a test: the suite must never depend on a workstation
 * being switched on (§6 phase 8). This exists so the prompt can be exercised
 * against the thing it was written for, which a stub cannot do.
 *
 *   OLLAMA_URL=http://<your-workstation>:11434 pnpm --filter api tsx src/scripts/llm-check.ts
 */
import "../lib/dotenv.js";
import { loadEnv } from "../env.js";
import { createLlmClient } from "../llm/client.js";
import { parseFoodMessages, readParsedFood } from "../llm/parse-food.js";

const SAMPLES = [
  "två ägg, en skiva rågbröd med smör och kaffe",
  "en tallrik havregrynsgröt med lingonsylt och en banan",
  "ostmacka och ett glas mjölk",
  "jag åt inget",
  "3 dl filmjölk med müsli",
];

const env = loadEnv();
const client = createLlmClient(env);

process.stdout.write(`host: ${env.OLLAMA_URL || "(not configured)"}\n`);
process.stdout.write(`model: ${env.OLLAMA_MODEL_SMALL}\n`);
process.stdout.write(`reachable: ${await client.reachable()}\n\n`);

for (const text of SAMPLES) {
  const reply = await client.chat({
    model: env.OLLAMA_MODEL_SMALL,
    messages: parseFoodMessages(text),
    json: true,
    temperature: 0,
    timeoutMs: env.OLLAMA_TIMEOUT_MS,
  });

  if (!reply.ok) {
    process.stdout.write(`${text}\n  -> unavailable: ${reply.reason} ${reply.detail ?? ""}\n\n`);
    continue;
  }

  const parsed = readParsedFood(reply.content);
  process.stdout.write(`${text}   [${reply.ms} ms]\n`);
  if (!parsed.ok) {
    process.stdout.write(`  -> REFUSED: ${parsed.detail}\n  raw: ${reply.content.slice(0, 200)}\n\n`);
    continue;
  }
  for (const item of parsed.items) {
    process.stdout.write(
      `  - ${item.name.padEnd(24)} ${String(item.estimatedGrams).padStart(5)} g   ${item.confidence}\n`,
    );
  }
  process.stdout.write("\n");
}

/* ------------------------------------------------------------- the recipe */

import { readGeneratedRecipe, recipeMessages } from "../llm/recipe.js";

const FRIDGE = [
  { have: "ägg, spenat, fetaost, tomat, rågbröd, smör, kycklingfilé, ris", budget: { kcal: 700, proteinG: 45, carbsG: 60, fatG: 25, approximate: false } },
  { have: "bara havregryn, mjölk och en banan", budget: { kcal: 400, proteinG: 20, carbsG: null, fatG: null, approximate: true } },
  { have: "torsk, potatis, dill, citron", budget: { kcal: null, proteinG: null, carbsG: null, fatG: null, approximate: false } },
];

for (const { have, budget } of FRIDGE) {
  const reply = await client.chat({
    model: env.OLLAMA_MODEL_LARGE,
    messages: recipeMessages(have, budget),
    json: true,
    temperature: 0.6,
    timeoutMs: env.OLLAMA_JOB_TIMEOUT_MS,
  });

  if (!reply.ok) {
    process.stdout.write(`\n[recept] ${have}\n  -> unavailable: ${reply.reason}\n`);
    continue;
  }

  const recipe = readGeneratedRecipe(reply.content);
  process.stdout.write(`\n[recept] ${have}   [${reply.ms} ms]\n`);
  if (!recipe.ok) {
    process.stdout.write(`  -> REFUSED: ${recipe.detail}\n  raw: ${reply.content.slice(0, 250)}\n`);
    continue;
  }
  process.stdout.write(`  ${recipe.title}\n`);
  for (const item of recipe.items) {
    process.stdout.write(`    - ${item.name.padEnd(22)} ${String(item.estimatedGrams).padStart(5)} g\n`);
  }
  for (const step of recipe.steps.slice(0, 3)) {
    process.stdout.write(`    · ${step}\n`);
  }
}
