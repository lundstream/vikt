import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueue,
  queueDegraded,
  resetQueueHealth,
  STORE_TIMEOUT_MS,
} from "../src/lib/queue/enqueue.js";
import { db } from "../src/lib/queue/db.js";

/**
 * A queue that opens and will not take a row (D118).
 *
 * This is the case `queue-fallback.test.ts` does **not** cover, and the gap was
 * not academic. `queueAvailable()` asks whether the database opens.  On the
 * phone this was found on it opened in 1 ms, a single `add` never completed,
 * and the server answered a health check in 115 ms. So the app refused to log
 * and told the owner to restart it, with a working server the whole time and a
 * direct-send fallback already written, tested and sitting one branch above,
 * unreachable because the wrong question had been asked.
 *
 * Opening is not the property that matters. Being able to write is, and there
 * is no way to test that except by writing, which is why the fallback is on the
 * failure of the write and not on a better availability check.
 *
 * The stall is simulated by making the `mutations` table hang rather than
 * throw, because a rejection would have been noticed years ago: the whole
 * difficulty of this failure is that nothing errors, and `withTimeout` is what
 * turns silence into an outcome.
 */

const ORIGINAL_FETCH = globalThis.fetch;

/** A promise that never settles, which is exactly what the phone did. */
const forever = () => new Promise(() => {});

let calls: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  resetQueueHealth();
  calls = [];
  vi.useFakeTimers();

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.fetch = ORIGINAL_FETCH;
  resetQueueHealth();
});

/** Runs `work` while the clock is pushed past the store deadline. */
async function past<T>(work: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(STORE_TIMEOUT_MS + 100);
  return work;
}

describe("a queue that opens and cannot be written to", () => {
  it("sends the write instead of refusing to log", async () => {
    vi.spyOn(db.mutations, "where").mockImplementation((() => ({
      equals: () => ({ first: forever }),
    })) as unknown as typeof db.mutations.where);

    const result = await past(
      enqueue({
        kind: "food-entry",
        body: { grams: 100 },
        timezone: "Europe/Stockholm",
        now: new Date("2026-09-06T10:00:00Z"),
      }),
    );

    // The row went out, which is the whole point: the server was reachable all
    // along and the old code threw SaveStalled instead of using it.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/api/");
    expect(calls[0]!.body.grams).toBe(100);

    // And the caller is told it is not resilient, rather than told it failed.
    expect(result.queued).toBe(false);
    expect(result.clientUuid).toBeTruthy();
    expect(result.localDate).toBe("2026-09-06");
  });

  /**
   * The second write does not pay the deadline again.
   *
   * Five seconds per tap is not a working app. A store that stalled once will
   * stall again, so the session gives up on it and goes straight out; a reload
   * re-tests it, which is the right granularity because whatever wedged the
   * store will not be fixed between two taps.
   */
  it("stops trying after the first stall", async () => {
    const where = vi.spyOn(db.mutations, "where").mockImplementation((() => ({
      equals: () => ({ first: forever }),
    })) as unknown as typeof db.mutations.where);

    await past(
      enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" }),
    );
    expect(queueDegraded()).toBe(true);

    const before = where.mock.calls.length;
    // No timer advance at all: if this one waited on the store it would hang.
    const second = await enqueue({
      kind: "weight",
      body: { weightKg: 86.9 },
      timezone: "Europe/Stockholm",
    });

    expect(second.queued).toBe(false);
    expect(where.mock.calls.length, "the store was touched again").toBe(before);
    expect(calls).toHaveLength(2);
  });

  /**
   * Only a stall falls through.
   *
   * A `ConstraintError` from the unique index on `clientUuid` is a real
   * conflict and means something quite different. Swallowing every error here
   * would turn a bug into a silent direct send, which is the D70 failure in a
   * new costume.
   */
  it("does not swallow a real database error", async () => {
    vi.spyOn(db.mutations, "where").mockImplementation((() => ({
      equals: () => ({
        first: async () => {
          throw new DOMException("key exists", "ConstraintError");
        },
      }),
    })) as unknown as typeof db.mutations.where);

    await expect(
      enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" }),
    ).rejects.toThrow(/key exists/);

    expect(calls, "a constraint error must not become a direct send").toHaveLength(0);
    expect(queueDegraded()).toBe(false);
  });

  /** And a healthy store still queues, so the fallback is not always on. */
  it("still queues when the store works", async () => {
    vi.useRealTimers();

    const result = await enqueue({
      kind: "food-entry",
      body: { grams: 250 },
      timezone: "Europe/Stockholm",
    });

    expect(result.queued).toBe(true);
    expect(queueDegraded()).toBe(false);
  });
});
