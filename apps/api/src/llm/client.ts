/**
 * Talking to Ollama.
 *
 * §6 phase 8 is unusually specific about the shape of this layer, and the
 * reason is in its first paragraph: the workstation is not always on, and
 * **nothing in phases 1 to 7 may depend on it**. So unavailability is not an
 * error condition here, it is one of the ordinary answers. Every function in
 * this file returns a discriminated result rather than throwing, because a
 * `catch` block is where "the box is off" turns into an error banner, and the
 * brief rules out the banner.
 *
 * **The native `/api/chat` endpoint, not the OpenAI-compatible `/v1/` one
 * (D71).** That is a deliberate departure from the letter of the brief, and it
 * was measured rather than assumed. `/v1/` silently ignores `think`, so the
 * reasoning models on this host reason at length and then have it discarded:
 * parsing one breakfast took **15.0 s and produced 1 399 characters of thrown
 * away reasoning**, against **0.56 s** for the identical prompt with
 * `think: false` on `/api/chat`. Same items, same grams. The brief's own note
 * that `/v1/` ignores request options is the same observation; it just picked a
 * different workaround.
 *
 * **`num_ctx` is never sent.** Changing it between calls forces Ollama to evict
 * and reload the model: an 11.9 s round trip for a prompt that answers in 0.56 s
 * once the options stop changing. If a bigger context is wanted, it belongs in
 * a saved model variant, which is what the brief says and is why the model
 * names are configuration.
 */

import type { Env } from "../env.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  /**
   * Base64 images, which Ollama's native endpoint takes **on the message**
   * rather than as a request option (D143).
   *
   * Optional and unset everywhere but the photo path. It is worth knowing that
   * this field passing validation proves nothing: four models on this host
   * advertise a `vision` capability, and one of them accepts the field and
   * answers that no image was attached. See `docs/measurements.md`.
   */
  images?: string[];
};

export type ChatOk = { ok: true; content: string; model: string; ms: number };

/**
 * Why a call produced nothing.
 *
 * Separated because they mean different things to a caller: `disabled` is a
 * configuration choice and should never be logged as a fault, `unreachable` is
 * the box being off, and `failed` is Ollama answering with something wrong.
 */
export type ChatFailure = {
  ok: false;
  reason: "disabled" | "unreachable" | "timeout" | "failed";
  detail?: string;
};

export type ChatResult = ChatOk | ChatFailure;

export type ChatOptions = {
  model: string;
  messages: ChatMessage[];
  /** Ask Ollama to constrain the output to JSON. */
  json?: boolean;
  timeoutMs: number;
  /** 0 for anything parsed. Higher only where variety is the point. */
  temperature?: number;
};

export type LlmClient = {
  enabled: boolean;
  chat(options: ChatOptions): Promise<ChatResult>;
  /**
   * The same call, delivered as it is generated (D139).
   *
   * Only the coach uses this. Everything else in this layer parses what comes
   * back, and half a JSON object is not a parseable thing; a conversation is
   * the one surface where the first sentence is worth having before the last
   * one exists. `onDelta` is called with each chunk of text, and the promise
   * still resolves with the whole reply, so a caller that needs both gets both.
   */
  chatStream(options: ChatOptions, onDelta: (text: string) => void): Promise<ChatResult>;
  /** Whether the host answered recently. Cached; see `health.ts`. */
  reachable(): Promise<boolean>;
};

type OllamaChatResponse = {
  message?: { content?: string; thinking?: string };
  error?: string;
};

export function createLlmClient(env: Env, fetchImpl: typeof fetch = fetch): LlmClient {
  const base = env.OLLAMA_URL.replace(/\/+$/, "");
  /**
   * Both, deliberately (D94). `LLM_ENABLED` is the operator's intent and
   * `OLLAMA_URL` is whether there is anything to talk to; an install with one
   * and not the other has not finished being configured, and the honest state
   * for that is off.
   */
  const enabled = base !== "" && env.LLM_ENABLED;

  async function post(
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ ok: true; body: unknown } | ChatFailure> {
    if (!enabled) return { ok: false, reason: "disabled" };

    /**
     * `AbortSignal.timeout` rather than a `setTimeout` race: a raced promise
     * leaves the request running, and on a host that is merely slow that means
     * a queue of abandoned generations competing for the same GPU.
     */
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          reason: "failed",
          detail: `${response.status} ${await response.text().catch(() => "")}`.slice(0, 300),
        };
      }

      return { ok: true, body: await response.json() };
    } catch (error) {
      const name = (error as Error).name;
      // `TimeoutError` from the signal, `AbortError` from an older runtime.
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "unreachable", detail: (error as Error).message.slice(0, 200) };
    }
  }

  return {
    enabled,

    async chat(options: ChatOptions): Promise<ChatResult> {
      const started = Date.now();

      const result = await post(
        "/api/chat",
        {
          model: options.model,
          messages: options.messages,
          stream: false,
          /**
           * The whole reason this is not the `/v1/` endpoint. These models
           * reason by default and `/v1/` cannot turn it off, which costs
           * 27 times the latency for output that does not differ (D71).
           */
          think: false,
          ...(options.json ? { format: "json" } : {}),
          // No `num_ctx`: sending it changes the loaded options and forces a
          // model reload. See the file comment.
          options: { temperature: options.temperature ?? 0 },
        },
        options.timeoutMs,
      );

      if (!result.ok) return result;

      const body = result.body as OllamaChatResponse;
      if (body.error) {
        return { ok: false, reason: "failed", detail: body.error.slice(0, 300) };
      }

      const content = body.message?.content ?? "";
      if (content.trim() === "") {
        return { ok: false, reason: "failed", detail: "empty response" };
      }

      return { ok: true, content, model: options.model, ms: Date.now() - started };
    },

    /**
     * Streaming, over the same native endpoint.
     *
     * Ollama answers `stream: true` with newline-delimited JSON, one object per
     * chunk, and the last one carries `done`. Parsed line by line off the body
     * rather than buffered, which is the entire point: a reply that takes eight
     * seconds should start arriving after one.
     *
     * Failures are the same discriminated union as `chat`, because the caller's
     * handling of "the box is off" must not depend on which method it used.
     */
    async chatStream(
      options: ChatOptions,
      onDelta: (text: string) => void,
    ): Promise<ChatResult> {
      if (!enabled) return { ok: false, reason: "disabled" };

      const started = Date.now();
      const signal = AbortSignal.timeout(options.timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            stream: true,
            think: false,
            options: { temperature: options.temperature ?? 0 },
          }),
          signal,
        });
      } catch (error) {
        const name = (error as Error).name;
        if (name === "TimeoutError" || name === "AbortError") {
          return { ok: false, reason: "timeout" };
        }
        return { ok: false, reason: "unreachable", detail: (error as Error).message.slice(0, 200) };
      }

      if (!response.ok || response.body === null) {
        return {
          ok: false,
          reason: "failed",
          detail: `${response.status} ${await response.text().catch(() => "")}`.slice(0, 300),
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let content = "";

      const consume = (line: string) => {
        const trimmed = line.trim();
        if (trimmed === "") return;

        let parsed: OllamaChatResponse & { done?: boolean };
        try {
          parsed = JSON.parse(trimmed) as OllamaChatResponse & { done?: boolean };
        } catch {
          // A half-written line from a chunk boundary. It arrives complete on
          // the next read, so dropping it here would lose text; it cannot,
          // because only whole lines are passed to this function.
          return;
        }

        const delta = parsed.message?.content ?? "";
        if (delta === "") return;
        content += delta;
        onDelta(delta);
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split(String.fromCharCode(10));
          // The last element is whatever came after the final newline, which is
          // either empty or the start of the next object.
          buffered = lines.pop() ?? "";
          for (const line of lines) consume(line);
        }
        consume(buffered);
      } catch (error) {
        const name = (error as Error).name;
        if (name === "TimeoutError" || name === "AbortError") {
          return { ok: false, reason: "timeout" };
        }
        return { ok: false, reason: "unreachable", detail: (error as Error).message.slice(0, 200) };
      }

      if (content.trim() === "") {
        return { ok: false, reason: "failed", detail: "empty response" };
      }

      return { ok: true, content, model: options.model, ms: Date.now() - started };
    },

    async reachable(): Promise<boolean> {
      if (!enabled) return false;
      try {
        const response = await fetchImpl(`${base}/api/version`, {
          // Much shorter than a chat: this only asks whether anything is
          // listening, and a host that takes two seconds to say its version is
          // not one to put on an interactive path.
          signal: AbortSignal.timeout(2000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
