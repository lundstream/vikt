import { describe, expect, it } from "vitest";
import { createLlmClient } from "../src/llm/client.js";
import { testEnv } from "./harness.js";

/**
 * Talking to Ollama, at the level of what comes back on the wire.
 *
 * Everything else stubs `LlmClient`, which is the right seam for a service
 * test and useless for the one thing this file is about: the reply shapes a
 * real host actually produces. Both of the rules held here were found by
 * running a real model and not by reading the API documentation.
 */

const ENV = testEnv({ OLLAMA_URL: "http://ollama.test", LLM_ENABLED: true });

/** A fetch that answers every call with one canned Ollama body. */
function answering(body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response) as unknown as typeof fetch;
}

describe("a reply whose content is in the wrong field", () => {
  /**
   * `qwen3-vl:8b` with a `format` constraint returns an empty `content` and the
   * whole JSON object in `thinking` — reproducibly, for every photograph tried,
   * with `think: false` set and honoured: 27 eval tokens, no reasoning prose,
   * 300 to 1100 ms. Drop the constraint and the same model behaves normally and
   * reasons for eighteen seconds instead.
   *
   * So it is Ollama labelling one field as the other for this build, the same
   * shape as D71's finding that `/v1/` ignores `think`. Without this the photo
   * path answered `failed: empty response` for every picture, which is what the
   * first run through the interface actually did (D143).
   */
  it("is read from thinking rather than called empty", async () => {
    const client = createLlmClient(
      ENV,
      answering({
        message: { content: "", thinking: '{"items":[{"name":"kebabpizza","amount":null}]}' },
      }),
    );

    const reply = await client.chat({
      model: "qwen3-vl:8b",
      messages: [{ role: "user", content: "vad är detta" }],
      timeoutMs: 1000,
    });

    expect(reply.ok).toBe(true);
    expect(reply.ok && reply.content).toContain("kebabpizza");
  });

  /** A fallback, never a preference: a model that answers properly is untouched. */
  it("still prefers content when there is any", async () => {
    const client = createLlmClient(
      ENV,
      answering({ message: { content: "the answer", thinking: "the reasoning" } }),
    );

    const reply = await client.chat({
      model: "gemma4:e4b",
      messages: [{ role: "user", content: "vad är detta" }],
      timeoutMs: 1000,
    });

    expect(reply.ok && reply.content).toBe("the answer");
  });

  /** And nothing anywhere is still nothing. */
  it("fails when both are empty", async () => {
    const client = createLlmClient(ENV, answering({ message: { content: "  " } }));

    const reply = await client.chat({
      model: "gemma4:e4b",
      messages: [{ role: "user", content: "vad är detta" }],
      timeoutMs: 1000,
    });

    expect(reply).toMatchObject({ ok: false, reason: "failed", detail: "empty response" });
  });
});
