import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { ChatMessage, ChatResult, LlmClient } from "../src/llm/client.js";
import { appSettings } from "../src/db/schema.js";
import {
  VISION_CHECK_SETTING,
  checkVisionModel,
  startVisionWatch,
  visionAvailable,
} from "../src/lib/vision-watch.js";
import { readSelfTest, selfTestImage } from "../src/llm/selftest-image.js";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * Asking the configured model whether it can see (D143).
 *
 * The probe's first finding is the whole reason this runs at boot: Ollama
 * reports a `vision` capability for four models on this workstation and one of
 * them accepts an image, answers fluently, and says nothing was attached. So
 * the server sends a picture whose contents it knows and reads the answer, and
 * the quick action exists only when something described the picture.
 *
 * What is held here is that **no answer means no surface** in every direction:
 * no model named, the box off, a model that answered about nothing, or a model
 * that was tested and then swapped for a different one.
 */

const VISION = { LLM_VISION_MODEL: "qwen3-vl:8b" } as const;

function stubLlm(reply: ChatResult, seen: ChatMessage[][] = []): LlmClient {
  return {
    enabled: true,
    chat: async (options) => {
      seen.push(options.messages);
      return reply;
    },
    chatStream: async () => reply,
    reachable: async () => true,
  };
}

const answers = (content: string): ChatResult => ({
  ok: true,
  content,
  model: "qwen3-vl:8b",
  ms: 2_400,
});

/** What a model that looked actually says. */
const SAW_IT = "En röd cirkel till vänster, en blå fyrkant till höger och texten VIKT.";

/** What `gemma4:e4b` said, twice, to this image and to a photograph. */
const DID_NOT_LOOK = "Jag kan tyvärr inte se någon bild. Du har inte bifogat någon bild.";

describe("a model that looks", () => {
  const seen: ChatMessage[][] = [];
  const ctx = useTestApp(VISION, { llm: stubLlm(answers(SAW_IT), seen) });

  it("is recorded, and the photo path becomes available", async () => {
    const { app, db } = ctx();

    expect(await checkVisionModel(db, app.config, app.llm)).toMatchObject({
      status: "sees",
      model: "qwen3-vl:8b",
    });
    expect(await visionAvailable(db, app.config)).toBe(true);
  });

  /** The image goes on the message, which is where Ollama takes it. */
  it("is sent a picture, not a description of one", async () => {
    const { app, db } = ctx();
    seen.length = 0;

    await checkVisionModel(db, app.config, app.llm);

    const image = seen.at(-1)?.at(-1)?.images?.[0];
    expect(image).toBeDefined();
    // The same bytes the probe sends, so the two agree about what was asked.
    expect(image).toBe(selfTestImage().toString("base64"));
  });
});

describe("a model that answers without looking", () => {
  const ctx = useTestApp(VISION, { llm: stubLlm(answers(DID_NOT_LOOK)) });

  /**
   * The case this exists for. It is not an error — the request succeeded and
   * the reply is well formed — which is exactly why a capability flag cannot
   * catch it.
   */
  it("is recorded as blind, and offers nothing", async () => {
    const { app, db } = ctx();

    expect(await checkVisionModel(db, app.config, app.llm)).toEqual({
      status: "blind",
      model: "qwen3-vl:8b",
      denied: true,
    });
    expect(await visionAvailable(db, app.config)).toBe(false);
  });
});

describe("an unreachable workstation", () => {
  const ctx = useTestApp(VISION, {
    llm: {
      enabled: true,
      chat: async () => ({ ok: false, reason: "unreachable" }),
      chatStream: async () => ({ ok: false, reason: "unreachable" }),
      reachable: async () => false,
    },
  });

  /**
   * Nothing is written. A stored "no" here would make the next boot believe the
   * model is blind when all that happened is somebody had their desktop off,
   * and the point of persisting the verdict is that it survives a restart.
   */
  it("records nothing at all, so a later boot can still find out", async () => {
    const { app, db } = ctx();

    expect(await checkVisionModel(db, app.config, app.llm)).toEqual({
      status: "unreachable",
      model: "qwen3-vl:8b",
    });

    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, VISION_CHECK_SETTING));
    expect(rows).toHaveLength(0);
  });
});

describe("the retry while the box is off", () => {
  /** Unreachable once, then answering. The second attempt is the one that counts. */
  let attempts = 0;
  const ctx = useTestApp(VISION, {
    llm: {
      enabled: true,
      chat: async () => {
        attempts += 1;
        return attempts === 1
          ? ({ ok: false, reason: "unreachable" } as ChatResult)
          : answers(SAW_IT);
      },
      chatStream: async () => answers(SAW_IT),
      reachable: async () => true,
    },
  });

  /**
   * The workstation being off is this installation's ordinary state — it is
   * somebody's desktop — so the answer is asked for again rather than settled
   * at boot. A blind model is not retried: that is a property of the tag and it
   * will not improve.
   */
  it("asks again, and the surface appears when the box comes back", async () => {
    const { app, db } = ctx();
    attempts = 0;

    const stop = startVisionWatch(db, app.config, app.llm, silentLog, 5);
    try {
      await vi.waitFor(async () => {
        expect(await visionAvailable(db, app.config)).toBe(true);
      });
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });
});

/** Nothing here asserts on log output; the lines are read by a person. */
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

describe("with no vision model named", () => {
  const seen: ChatMessage[][] = [];
  const ctx = useTestApp({}, { llm: stubLlm(answers(SAW_IT), seen) });

  it("asks nothing and offers nothing", async () => {
    const { app, db } = ctx();
    seen.length = 0;

    expect(await checkVisionModel(db, app.config, app.llm)).toEqual({ status: "off" });
    expect(seen).toHaveLength(0);
    expect(await visionAvailable(db, app.config)).toBe(false);
  });
});

describe("a verdict about a different model", () => {
  const ctx = useTestApp({ LLM_VISION_MODEL: "a-newer-tag" }, {
    llm: stubLlm(answers(SAW_IT)),
  });

  /**
   * Swapping `LLM_VISION_MODEL` takes the surface away until the next boot has
   * asked about the new tag. The safe direction: an offer that turns out to be
   * wrong is worse than one that arrives a restart late.
   */
  it("does not vouch for the model now configured", async () => {
    const { app, db } = ctx();

    await db.insert(appSettings).values({
      key: VISION_CHECK_SETTING,
      value: JSON.stringify({
        model: "the-tag-that-was-tested",
        sees: true,
        checkedAt: "2026-09-01T00:00:00.000Z",
      }),
    });

    expect(await visionAvailable(db, app.config)).toBe(false);
  });
});

describe("the health endpoint", () => {
  const ctx = useTestApp(VISION, { llm: stubLlm(answers(SAW_IT)) });

  /**
   * The same path the client already reads `LLM_ENABLED` from. One request
   * answers every question the food screen has about this layer, which is what
   * keeps the quick action's condition on one line.
   */
  it("carries the verdict, not the configuration", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const before = await app.inject({
      method: "GET",
      url: "/api/llm/health",
      headers: auth(user),
    });
    expect(before.json()).toMatchObject({ vision: false });

    await checkVisionModel(db, app.config, app.llm);

    const after = await app.inject({
      method: "GET",
      url: "/api/llm/health",
      headers: auth(user),
    });
    expect(after.json()).toMatchObject({ vision: true });
  });
});

describe("reading an answer", () => {
  /**
   * Two of five groups, which is not a bar anything clears by guessing. The
   * wording is allowed to vary — "kvadrat", "fyrkant" and "ruta" are the same
   * observation — and the count is what decides.
   */
  it.each([
    ["En röd cirkel och en blå kvadrat.", true],
    ["Bilden visar en cirkel i rött och ordet VIKT.", true],
    ["Jag ser en röd form.", false],
    ["Du har inte bifogat någon bild.", false],
    ["I'm sorry, I cannot see any image.", false],
  ])("%s", (answer, expected) => {
    expect(readSelfTest(answer).sees).toBe(expected);
  });

  /**
   * Denial is separated from a wrong description, because they call for
   * different next steps and only one of them is worth arguing with.
   */
  it("tells a denial apart from a bad description", () => {
    expect(readSelfTest(DID_NOT_LOOK).denied).toBe(true);
    expect(readSelfTest("En grön triangel.").denied).toBe(false);
  });
});

describe("the image itself", () => {
  /** A real PNG, so the failure is never "the bytes were not a picture". */
  it("is a PNG with contents", () => {
    const image = selfTestImage();

    expect(image.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(image.includes(Buffer.from("IHDR"))).toBe(true);
    expect(image.includes(Buffer.from("IEND"))).toBe(true);
    expect(image.length).toBeGreaterThan(500);
  });
});
