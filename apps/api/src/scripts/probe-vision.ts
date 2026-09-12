import "../lib/dotenv.js";
import { readFileSync } from "node:fs";
import {
  SELF_TEST_PROMPT,
  readSelfTest,
  selfTestImage,
} from "../llm/selftest-image.js";

/**
 * Does a model on this workstation actually look at an image?
 *
 * `pnpm --filter api probe:vision --selftest` before configuring
 * `LLM_VISION_MODEL`, and `pnpm --filter api probe:vision <photo.jpg>` when a
 * plate comes back wrong and you want to see what the model saw.
 *
 * It is a maintained script rather than a note in a decision record because the
 * question it answers keeps mattering. Ollama reports a `vision` capability for
 * four of the models on this host, and one of them accepts an image, answers
 * fluently, and says nothing was attached — twice, once to a generated picture
 * and once to a photograph of dinner (`docs/measurements.md`). A capability flag
 * describes a build; this asks the tag in front of you. The API runs the same
 * check at boot and hides the photo surface when it fails, so what this adds is
 * the ability to find a tag that works *before* changing the configuration, and
 * to see the timings.
 *
 * It shares `selftest-image.ts` with the boot check deliberately: two probes
 * asking slightly different questions would eventually disagree, and the one an
 * operator runs by hand has to be the one the server runs by itself.
 *
 * Two modes:
 *
 *   probe:vision --selftest [model ...]
 *     The generated picture — a red circle, a blue square, the word VIKT — and
 *     the same verdict the boot check applies. This answers "does the image
 *     reach the model at all", which is worth separating from "it looked and
 *     guessed badly": only one of those is the model's fault.
 *
 *   probe:vision <photo.jpg> [model ...]
 *     A real photograph, printed with the time it took. The one that matters
 *     for choosing a tag, because a plate is what this feature is for and a
 *     stock image is a picture a model may have been trained on.
 *
 * With no models named it tries `LLM_VISION_MODEL` and then the other tags this
 * installation has had reason to consider.
 */

const host = (process.env.OLLAMA_URL ?? "").replace(/\/+$/, "");

if (host === "") {
  console.error("No OLLAMA_URL. Nothing to probe.");
  process.exit(1);
}

const args = process.argv.slice(2);
const selftest = args[0] === "--selftest";
const source = selftest ? null : args[0];

if (!selftest && (source === undefined || source === "")) {
  console.error("Usage: probe:vision --selftest [model ...] | probe:vision <photo.jpg> [model ...]");
  process.exit(1);
}

const named = args.slice(1);
const models =
  named.length > 0
    ? named
    : [process.env.LLM_VISION_MODEL ?? "", "qwen3-vl:8b", "qwen3.6:27b", "gemma4:e4b"].filter(
        (name, index, all) => name !== "" && all.indexOf(name) === index,
      );

const image = selftest ? selfTestImage() : readFileSync(source!);
const prompt = selftest
  ? SELF_TEST_PROMPT
  : "Vad ligger på tallriken? Räkna upp maten du ser, en per rad, med ungefärlig mängd. Svara kort, på svenska.";

console.log(`host: ${host}`);
console.log(
  `image: ${selftest ? "generated PNG" : source} (${Math.round(image.length / 1024)} kB)`,
);
console.log(`models: ${models.join(", ")}\n`);

/**
 * What Ollama currently has resident, if it will say.
 *
 * Printed before and after, because the thing worth knowing on a one-GPU box is
 * whether sending a photograph evicts the text model the coach and the parser
 * are using. See `docs/measurements.md`.
 */
await resident("before");

for (const model of models) {
  const started = Date.now();

  try {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [{ role: "user", content: prompt, images: [image.toString("base64")] }],
      }),
      signal: AbortSignal.timeout(180_000),
    });

    const ms = Date.now() - started;

    if (!response.ok) {
      console.log(`${model}: HTTP ${response.status} after ${ms} ms`);
      console.log(`  ${(await response.text()).slice(0, 300)}\n`);
      continue;
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const text = (body.message?.content ?? "").trim();

    console.log(`${model}: ${ms} ms`);
    console.log(
      text === "" ? "  (empty answer)" : text.split("\n").map((line) => `  ${line}`).join("\n"),
    );

    if (selftest) {
      const verdict = readSelfTest(text);
      console.log(
        `  → ${verdict.sees ? "SEES" : "DOES NOT SEE"} (${verdict.matched}/5 things named${
          verdict.denied ? ", denied receiving an image" : ""
        })`,
      );
    }
    console.log("");
  } catch (error) {
    console.log(`${model}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`);
  }
}

await resident("after");

async function resident(when: string): Promise<void> {
  try {
    const response = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return;

    const body = (await response.json()) as {
      models?: { name?: string; size_vram?: number; expires_at?: string }[];
    };
    const loaded = body.models ?? [];

    console.log(
      `loaded ${when}: ${
        loaded.length === 0
          ? "nothing"
          : loaded
              .map(
                (entry) =>
                  `${entry.name ?? "?"} (${Math.round((entry.size_vram ?? 0) / 1e9)} GB)`,
              )
              .join(", ")
      }\n`,
    );
  } catch {
    // The host may not expose /api/ps. Not worth failing a probe over.
  }
}
