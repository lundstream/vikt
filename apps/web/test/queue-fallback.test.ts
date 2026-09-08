import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue } from "../src/lib/queue/enqueue.js";
import { ApiError } from "../src/lib/api.js";

/**
 * What happens when there is no usable queue (D70).
 *
 * Deliberately in its own file with **no** `fake-indexeddb`, because that is the
 * condition being tested: a private window, storage the browser will not grant,
 * or a database that will not open. `queue.test.ts` imports the polyfill at the
 * top and cannot also test its absence.
 *
 * The branch used to return without writing anywhere and without making a
 * request, on the strength of a comment saying the write went straight out.
 * Nothing did. Every entry made without a queue was silently discarded — the
 * worst failure mode this app has — and it stayed invisible because the branch
 * was almost never taken. Making a blocked database fall through to it is what
 * turned that into something a person would meet.
 */

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  // No IndexedDB at all: `queueAvailable()` must answer false rather than wait.
  vi.stubGlobal("indexedDB", undefined);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllGlobals();
});

describe("logging without a queue", () => {
  it("sends the write instead of dropping it", async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;

    const result = await enqueue({
      kind: "food-entry",
      body: { grams: 100 },
      timezone: "Europe/Stockholm",
    });

    expect(result.queued).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/food-entry");
    // The day and its provenance travel with it, exactly as a queued write does.
    expect(calls[0]!.body).toMatchObject({
      grams: 100,
      localDate: result.localDate,
      dateSource: "device",
    });
  });

  it("routes each kind to its own endpoint", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;

    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });
    await enqueue({ kind: "manual-intake", body: { kcal: 1800 }, timezone: "Europe/Stockholm" });

    expect(urls).toEqual(["/api/weight", "/api/manual-intake"]);
  });

  /**
   * Thrown, not swallowed. There is no queue to park the entry in and no later
   * attempt to make, so the only honest thing is to let the screen say it did
   * not save (D42).
   */
  it("throws on a refusal rather than reporting success", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 422,
        json: async () => ({ error: "no_energy", message: "Saknar energivärde." }),
      }) as Response) as typeof fetch;

    await expect(
      enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("carries the server's own message, so the screen can show it", async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 422,
        json: async () => ({ error: "no_energy", message: "Saknar energivärde." }),
      }) as Response) as typeof fetch;

    await expect(
      enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" }),
    ).rejects.toThrow("Saknar energivärde.");
  });
});
