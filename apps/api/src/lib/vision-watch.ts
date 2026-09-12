import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import type { LlmClient } from "../llm/client.js";
import { appSettings } from "../db/schema.js";
import { SELF_TEST_PROMPT, readSelfTest, selfTestImage } from "../llm/selftest-image.js";

/**
 * Asking the configured vision model whether it can actually see (D143).
 *
 * The probe that preceded this feature found the reason it has to exist: Ollama
 * reports a `vision` capability for four models on this workstation and one of
 * them accepts an image, answers fluently, and says nothing was attached. A
 * flag is a claim about a build; a working installation needs a claim about the
 * tag in front of it, and the only way to have one is to send a picture with
 * known contents and read the answer.
 *
 * So the API does at boot what an operator would do by hand, and the client
 * reads the answer through the same health endpoint it already reads
 * `LLM_ENABLED` from. **No answer means no surface**: the quick action is
 * absent, exactly as it is when the layer is off, because the alternative is a
 * door that opens onto a model describing a plate it never received.
 *
 * Three rules it never breaks:
 *
 * **It is never fatal and never awaited.** Booting is not the moment to find
 * out whether a workstation on the LAN is switched on.
 *
 * **A model that cannot see is said once, by name.** One warning line, at the
 * boot that discovered it, naming the tag so the operator knows what to change.
 * Not once an hour: it is a property of that model and it will not improve.
 *
 * **An unreachable box is retried, a blind model is not.** "The workstation is
 * off" is the ordinary state of this installation and becomes false on its own;
 * "this tag does not look at images" does not.
 */

/** The one entry this file owns. Holds the model name and the verdict. */
export const VISION_CHECK_SETTING = "vision_model_check";

/** How often to ask again while the box is not answering. */
export const VISION_RETRY_MS = 60 * 60_000;

export type VisionCheck =
  /** No layer, or no model named. Nothing to ask and nothing to offer. */
  | { status: "off" }
  /** It looked. The photo path is offered. */
  | { status: "sees"; model: string; ms: number }
  /** It answered about nothing. One warning, no surface, no retry. */
  | { status: "blind"; model: string; denied: boolean }
  /** The workstation is off. Ask again in an hour. */
  | { status: "unreachable"; model: string };

type Stored = { model: string; sees: boolean; checkedAt: string };

/**
 * Whether the photo path may be offered, as the health endpoint reports it.
 *
 * Reads the stored verdict and **requires it to be about the model currently
 * configured**. Changing `LLM_VISION_MODEL` to something untested therefore
 * takes the surface away until the next boot has asked, which is the safe
 * direction: an offer that turns out to be wrong is worse than one that arrives
 * a restart late.
 */
export async function visionAvailable(db: Db, env: Env): Promise<boolean> {
  const model = env.LLM_VISION_MODEL.trim();
  if (!env.LLM_ENABLED || model === "") return false;

  const stored = await readStored(db);
  return stored !== null && stored.model === model && stored.sees;
}

/**
 * Sends the self-test image and records what came back.
 *
 * Returns what it found rather than logging it, so the caller decides how loud
 * to be and a test can read the answer — the same shape as `checkVapidKey`.
 */
export async function checkVisionModel(
  db: Db,
  env: Env,
  client: LlmClient,
): Promise<VisionCheck> {
  const model = env.LLM_VISION_MODEL.trim();
  if (!env.LLM_ENABLED || model === "" || !client.enabled) return { status: "off" };

  const reply = await client.chat({
    model,
    messages: [
      {
        role: "user",
        content: SELF_TEST_PROMPT,
        images: [selfTestImage().toString("base64")],
      },
    ],
    temperature: 0,
    timeoutMs: env.OLLAMA_VISION_TIMEOUT_MS,
  });

  if (!reply.ok) {
    /**
     * Nothing is written for a failure to reach the box. A stored "no" would
     * make the next boot believe the model is blind when all that happened is
     * that somebody had the workstation off, and the whole point of persisting
     * the verdict is that it survives a restart.
     */
    return { status: "unreachable", model };
  }

  const verdict = readSelfTest(reply.content);
  await remember(db, { model, sees: verdict.sees, checkedAt: new Date().toISOString() });

  return verdict.sees
    ? { status: "sees", model, ms: reply.ms }
    : { status: "blind", model, denied: verdict.denied };
}

/**
 * The boot call, with the hourly retry while the box is unreachable.
 *
 * Returns a stop function. Nothing in production calls it — the process ends
 * instead — but a test that leaves an hourly timer behind is a test that keeps
 * the runner alive, and an unstoppable timer is a thing nobody can write a test
 * around.
 */
export function startVisionWatch(
  db: Db,
  env: Env,
  client: LlmClient,
  log: { info: (data: object, message: string) => void; warn: (data: object, message: string) => void; error: (data: object, message: string) => void },
  retryMs: number = VISION_RETRY_MS,
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const run = () => {
    void checkVisionModel(db, env, client)
      .then((check) => {
        if (stopped) return;

        if (check.status === "sees") {
          log.info({ model: check.model, ms: check.ms }, "the vision model can see");
          return;
        }

        if (check.status === "blind") {
          log.warn(
            { model: check.model, denied: check.denied },
            "the configured vision model answered without looking at the image. " +
              "Photo logging stays off. Try another tag with " +
              "`pnpm --filter api probe:vision --selftest`",
          );
          return;
        }

        if (check.status === "unreachable") {
          // No line. An unreachable workstation is this installation's ordinary
          // state and logging it hourly would be noise about nothing.
          timer = setTimeout(run, retryMs);
          timer.unref?.();
        }
      })
      .catch((error: unknown) => {
        if (stopped) return;
        log.error({ err: error }, "could not check the vision model");
      });
  };

  run();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function readStored(db: Db): Promise<Stored | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, VISION_CHECK_SETTING))
    .limit(1);

  if (!row) return null;
  try {
    return JSON.parse(row.value) as Stored;
  } catch {
    // A value this file did not write. Treated as no answer, which costs a
    // surface until the next boot and is better than trusting an unknown shape.
    return null;
  }
}

async function remember(db: Db, value: Stored): Promise<void> {
  const encoded = JSON.stringify(value);
  await db
    .insert(appSettings)
    .values({ key: VISION_CHECK_SETTING, value: encoded })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: encoded, updatedAt: new Date() },
    });
}
