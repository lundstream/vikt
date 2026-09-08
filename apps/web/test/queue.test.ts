import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateSourceOf, db } from "../src/lib/queue/db.js";
import { enqueue } from "../src/lib/queue/enqueue.js";
import {
  onQueueSent,
  backoffMs,
  discardMutation,
  drainQueue,
  MAX_ATTEMPTS,
  pendingCount,
  retryMutation,
} from "../src/lib/queue/sync.js";
import { toLocalDate } from "../src/lib/dates.js";

/**
 * The offline queue.
 *
 * Four decisions are held here: the day an entry belongs to (D39), replay being
 * normal (D40), what a rejection does (D42), and what a conflict does (D41).
 * The conflict rule's server half lives in `apps/api/test/queue-conflict.test.ts`.
 */

beforeEach(async () => {
  await db.mutations.clear();
  await db.conflicts.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fetch that answers however the test says, and records what it was sent. */
function stubFetch(
  reply: (call: number) => { ok: boolean; status?: number; body?: unknown },
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let call = 0;

  const impl = (async (url: string, init?: RequestInit) => {
    call += 1;
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    const answer = reply(call);
    return {
      ok: answer.ok,
      status: answer.status ?? (answer.ok ? 200 : 500),
      json: async () => answer.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

const ok = () => ({ ok: true });

describe("the day an entry belongs to (D39)", () => {
  /**
   * The case this rule exists for. An entry typed at 23:50 and synced at 08:00
   * the next morning must keep the day it was created on. Deriving the day at
   * send time would move every late-night entry forward, silently, and only for
   * people who log late.
   */
  it("keeps the creation date across midnight", async () => {
    // 23:50 in Stockholm on the 1st.
    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Europe/Stockholm",
      now: new Date("2026-03-01T22:50:00.000Z"),
    });
    expect(created.localDate).toBe("2026-03-01");

    // Sync happens the next morning; the row already carries its day.
    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);

    expect(calls[0]!.body.localDate).toBe("2026-03-01");
  });

  it("keeps the timezone it was created in, not the one it synced in", async () => {
    // 16:00 UTC is 01:00 the next day in Tokyo and still 17:00 the same day in
    // Stockholm. One instant, two dates: the whole reason `localDate` is a
    // client fact and not something the server may derive.
    const instant = new Date("2026-03-01T16:00:00.000Z");

    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Asia/Tokyo",
      now: instant,
    });

    expect(created.localDate).toBe("2026-03-02");
    expect(toLocalDate(instant, "Europe/Stockholm")).toBe("2026-03-01");

    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);

    expect(calls[0]!.body.localDate).toBe("2026-03-02");
  });

  it("uses an explicit date when one is given, for logging a past day", async () => {
    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Europe/Stockholm",
      localDate: "2026-01-15",
    });

    expect(created.localDate).toBe("2026-01-15");
  });
});

/**
 * `localDate` holds two different facts, and until now nothing could tell them
 * apart (D61): the device's own day boundary, and a day a person picked.
 */
describe("where the day came from (D61)", () => {
  it("marks a date the device computed as the device's", async () => {
    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Europe/Stockholm",
      now: new Date("2026-03-01T10:00:00.000Z"),
    });

    expect(created.dateSource).toBe("device");

    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);
    expect(calls[0]!.body.dateSource).toBe("device");
  });

  it("marks a backfill as chosen, and keeps both across a later sync", async () => {
    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Europe/Stockholm",
      localDate: "2026-01-15",
      now: new Date("2026-03-01T10:00:00.000Z"),
    });

    expect(created.localDate).toBe("2026-01-15");
    expect(created.dateSource).toBe("chosen");

    // The whole point: syncing weeks later rewrites neither.
    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);
    expect(calls[0]!.body.localDate).toBe("2026-01-15");
    expect(calls[0]!.body.dateSource).toBe("chosen");
  });

  /**
   * The screens pass their selected date on every write, and on most days that
   * date is today. Calling those "chosen" would make the distinction useless by
   * making nearly everything chosen.
   */
  it("calls a supplied date that equals today the device's anyway", async () => {
    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Europe/Stockholm",
      localDate: "2026-03-01",
      now: new Date("2026-03-01T10:00:00.000Z"),
    });

    expect(created.dateSource).toBe("device");
  });

  it("judges that against the creating timezone, not UTC", async () => {
    // 16:00 UTC is already the 2nd in Tokyo. Passing the Tokyo day is the
    // device's own day, not a backfill.
    const created = await enqueue({
      kind: "weight",
      body: { weightKg: 84.2 },
      timezone: "Asia/Tokyo",
      localDate: "2026-03-02",
      now: new Date("2026-03-01T16:00:00.000Z"),
    });

    expect(created.dateSource).toBe("device");
  });
});

describe("replay (D40)", () => {
  it("removes a mutation once the server accepts it", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });
    const { impl } = stubFetch(ok);

    const result = await drainQueue(impl);

    expect(result.sent).toBe(1);
    expect(await pendingCount()).toBe(0);
  });

  it("sends the same client_uuid on every attempt", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });

    // Fail once, then succeed.
    const { impl, calls } = stubFetch((call) => (call === 1 ? { ok: false, status: 503 } : ok()));

    await drainQueue(impl);
    // Clear the backoff so the second attempt is due.
    await db.mutations.toCollection().modify({ nextAttemptAt: null });
    await drainQueue(impl);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.clientUuid).toBe(calls[1]!.body.clientUuid);
    expect(await pendingCount()).toBe(0);
  });

  it("re-queueing the same key amends rather than adding a second write", async () => {
    const first = await enqueue({
      kind: "weight",
      body: { weightKg: 84 },
      timezone: "Europe/Stockholm",
    });
    await enqueue({
      kind: "weight",
      body: { weightKg: 83.5 },
      timezone: "Europe/Stockholm",
      clientUuid: first.clientUuid,
    });

    expect(await db.mutations.count()).toBe(1);
    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);
    expect(calls[0]!.body.weightKg).toBe(83.5);
  });

  it("marks the write as coming from the queue, so the server can tell", async () => {
    await enqueue({
      kind: "weight",
      body: { weightKg: 84, fromQueue: true },
      timezone: "Europe/Stockholm",
    });
    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);

    expect(calls[0]!.body.fromQueue).toBe(true);
  });

  it("sends in creation order", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });
    await enqueue({
      kind: "manual-intake",
      body: { kcal: 2000 },
      timezone: "Europe/Stockholm",
    });

    const { impl, calls } = stubFetch(ok);
    await drainQueue(impl);

    expect(calls.map((call) => call.url)).toEqual(["/api/weight", "/api/manual-intake"]);
  });
});

describe("a rejection (D42)", () => {
  /**
   * A 4xx means the server read it and said no. Sending the identical bytes to
   * the identical rule gets the identical answer, so it stops and asks a person.
   */
  it("does not retry a 422 at all", async () => {
    await enqueue({
      kind: "manual-intake",
      body: { kcal: 100 },
      timezone: "Europe/Stockholm",
    });

    const { impl, calls } = stubFetch(() => ({
      ok: false,
      status: 422,
      body: { error: "intake_below_system_floor", message: "För lågt." },
    }));

    await drainQueue(impl);
    await drainQueue(impl);
    await drainQueue(impl);

    expect(calls).toHaveLength(1);
  });

  it("keeps what the user typed rather than discarding it", async () => {
    await enqueue({
      kind: "manual-intake",
      body: { kcal: 100 },
      timezone: "Europe/Stockholm",
    });
    const { impl } = stubFetch(() => ({
      ok: false,
      status: 422,
      body: { error: "intake_below_system_floor", message: "För lågt." },
    }));

    await drainQueue(impl);

    const row = await db.mutations.toCollection().first();
    expect(row?.status).toBe("failed");
    expect(row?.body.kcal).toBe(100);
    expect(row?.failure?.message).toBe("För lågt.");
  });

  it("can be put back in the queue once the user has dealt with it", async () => {
    await enqueue({
      kind: "manual-intake",
      body: { kcal: 100 },
      timezone: "Europe/Stockholm",
    });
    const rejecting = stubFetch(() => ({ ok: false, status: 422, body: { error: "x" } }));
    await drainQueue(rejecting.impl);

    const row = (await db.mutations.toCollection().first())!;
    await retryMutation(row.id!);

    const accepting = stubFetch(ok);
    const result = await drainQueue(accepting.impl);

    expect(result.sent).toBe(1);
    expect(await db.mutations.count()).toBe(0);
  });

  it("can be discarded, but only deliberately", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 999 }, timezone: "Europe/Stockholm" });
    const row = (await db.mutations.toCollection().first())!;

    await discardMutation(row.id!);
    expect(await db.mutations.count()).toBe(0);
  });

  /** Being offline is not a rejection: it keeps trying, with a backoff. */
  it("retries a transport failure with a growing delay", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });

    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    await drainQueue(impl);
    const row = (await db.mutations.toCollection().first())!;

    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(backoffMs(1)).toBeLessThan(backoffMs(4));
  });

  it("stops retrying a transport failure eventually, keeping the entry", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });
    const impl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      await db.mutations.toCollection().modify({ nextAttemptAt: null });
      await drainQueue(impl);
    }

    const row = (await db.mutations.toCollection().first())!;
    expect(row.status).toBe("failed");
    expect(row.body.weightKg).toBe(84);
  });

  /** An expired session is not the entry's fault, and must not lose it. */
  it("leaves a 401 pending rather than failing the entry", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });
    const { impl } = stubFetch(() => ({ ok: false, status: 401 }));

    await drainQueue(impl);
    const row = (await db.mutations.toCollection().first())!;

    expect(row.status).toBe("pending");
  });
});

describe("a conflict (D41)", () => {
  it("records the day for the user to settle, without resending", async () => {
    await enqueue({
      kind: "weight",
      body: { weightKg: 83.1 },
      timezone: "Europe/Stockholm",
      localDate: "2026-03-01",
    });

    const { impl, calls } = stubFetch(() => ({
      ok: false,
      status: 409,
      body: {
        error: "day_already_written",
        message: "Redan skriven.",
        existing: { weightKg: 84.2 },
      },
    }));

    await drainQueue(impl);
    await drainQueue(impl);

    expect(calls).toHaveLength(1);

    const conflict = (await db.conflicts.toCollection().first())!;
    expect(conflict.localDate).toBe("2026-03-01");
    expect(conflict.mine.weightKg).toBe(83.1);
    expect(conflict.theirs.weightKg).toBe(84.2);
    expect(conflict.resolvedAt).toBeNull();
  });

  it("keeps the losing entry rather than throwing it away", async () => {
    await enqueue({ kind: "weight", body: { weightKg: 83.1 }, timezone: "Europe/Stockholm" });
    const { impl } = stubFetch(() => ({
      ok: false,
      status: 409,
      body: { error: "day_already_written", existing: { weightKg: 84.2 } },
    }));

    await drainQueue(impl);
    const row = (await db.mutations.toCollection().first())!;

    expect(row.status).toBe("conflict");
    expect(row.body.weightKg).toBe(83.1);
  });
});

/**
 * The list was always one entry behind.
 *
 * `enqueueAndSync` resolves as soon as the entry is stored locally, which is
 * the point (D39-D42). What went wrong is that the mutation's `onSuccess`
 * invalidated the cache at that moment, so the refetch raced the POST and
 * normally won: the list came back without the entry that had just been added
 * and stayed one short until a manual reload. The day's calorie total, which
 * every other number on the dashboard is built from, was wrong on screen while
 * the user was looking at it.
 *
 * So the refetch is driven by the queue telling the cache when the **server**
 * actually has the write.
 */
describe("telling the cache when the server has it", () => {
  it("does not fire while the entry is only stored locally", async () => {
    const seen: string[][] = [];
    const off = onQueueSent((kinds) => seen.push([...kinds]));

    await enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" });

    // Enqueued, not sent. Nothing on the server to re-read yet.
    expect(seen).toEqual([]);
    off();
  });

  it("fires once the send succeeds, naming the kind", async () => {
    const seen: string[][] = [];
    const off = onQueueSent((kinds) => seen.push([...kinds]));

    await enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" });
    const { impl } = stubFetch(ok);
    await drainQueue(impl);

    expect(seen).toEqual([["food-entry"]]);
    off();
  });

  it("does not fire when the send fails, because nothing changed", async () => {
    const seen: string[][] = [];
    const off = onQueueSent((kinds) => seen.push([...kinds]));

    await enqueue({ kind: "food-entry", body: { grams: 100 }, timezone: "Europe/Stockholm" });
    const { impl } = stubFetch(() => {
      throw new TypeError("offline");
    });
    await drainQueue(impl);

    expect(seen).toEqual([]);
    off();
  });

  /** One refetch per affected list, not one per entry. */
  it("collapses a drain of several entries into one notification", async () => {
    const seen: string[][] = [];
    const off = onQueueSent((kinds) => seen.push([...kinds]));

    for (const grams of [100, 200, 300]) {
      await enqueue({ kind: "food-entry", body: { grams }, timezone: "Europe/Stockholm" });
    }
    await enqueue({ kind: "weight", body: { weightKg: 84 }, timezone: "Europe/Stockholm" });

    const { impl } = stubFetch(ok);
    await drainQueue(impl);

    expect(seen).toHaveLength(1);
    expect(new Set(seen[0])).toEqual(new Set(["food-entry", "weight"]));
    off();
  });
});

/**
 * The hang, and the data loss behind it (D70).
 *
 * `dateSource` was added with a Dexie `version(2)` whose only job was to stamp
 * existing rows: the field is not indexed, so it needed no schema change at
 * all. That upgrade cannot run while another connection holds the database at
 * the old version — a second tab, or the installed app beside a browser tab —
 * so `indexedDB.open` fires `blocked` and never settles. `db.open()` was
 * awaited with no bound, so every log write hung on "Sparar…" forever.
 */
describe("the queue opening", () => {
  it("stays on one schema version, so an upgrade can never block it", () => {
    // Dexie reports its version times ten. Two versions would be 20.
    expect(db.verno).toBe(1);
  });

  it("defaults the date provenance for rows written before the field existed", () => {
    expect(
      dateSourceOf({
        clientUuid: "x",
        kind: "weight",
        body: {},
        localDate: "2026-01-01",
        timezone: "Europe/Stockholm",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        failure: null,
      }),
    ).toBe("device");
  });

  it("keeps an explicit provenance when the row has one", () => {
    expect(
      dateSourceOf({
        clientUuid: "x",
        kind: "weight",
        body: {},
        localDate: "2026-01-01",
        dateSource: "chosen",
        timezone: "Europe/Stockholm",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        failure: null,
      }),
    ).toBe("chosen");
  });
});
