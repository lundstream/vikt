import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/queue/db.js";
import { enqueue } from "../src/lib/queue/enqueue.js";
import {
  applyQueuedReading,
  drainQueue,
  keepServerReading,
  requestFor,
} from "../src/lib/queue/sync.js";

/**
 * Editing a reading is a different queue operation from logging one (D150).
 *
 * The defect: the edit sheet enqueued a **create** with a fresh `clientUuid`,
 * so an edit to a day that already had a reading arrived as a queued write for
 * an occupied day. D41's rule fired exactly as written and the page reported
 * "two devices wrote this day" about one device editing its own reading, with a
 * queued row whose "Försök igen" could never succeed.
 *
 * Held here: an update is addressed to its row and replays as one, and a real
 * same-day conflict offers two resolutions that each leave exactly one row.
 */

const TZ = "Europe/Stockholm";

beforeEach(async () => {
  await db.mutations.clear();
  await db.conflicts.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fetch that records what it was asked and answers with what it is told. */
function answering(
  reply: (url: string, init: RequestInit | undefined) => { status: number; body?: unknown },
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const { status, body } = reply(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

describe("where an operation is sent", () => {
  /** A create is a POST to the collection. Unchanged. */
  it("posts a create to /api/weight", () => {
    expect(requestFor({ kind: "weight", body: {} })).toEqual({
      url: "/api/weight",
      method: "POST",
    });
  });

  /**
   * An update addresses a row. The path is the authority on which reading is
   * being changed, so a body that disagreed could not reach a different one.
   */
  it("puts an update to the row it means", () => {
    expect(requestFor({ kind: "weight-update", body: { id: "abc-123" } })).toEqual({
      url: "/api/weight/abc-123",
      method: "PUT",
    });
  });
});

describe("an edit made offline", () => {
  /**
   * The 24 August case. It replays as an update to the row, not as a create for
   * the day, which is what makes it go through instead of colliding with the
   * reading it is editing.
   */
  it("replays as an update and goes through", async () => {
    const { impl, calls } = answering(() => ({ status: 200, body: {} }));

    await enqueue({
      kind: "weight-update",
      timezone: TZ,
      localDate: "2026-08-24",
      body: {
        id: "row-1",
        localDate: "2026-08-24",
        baselineWeightKg: 110,
        weightKg: 110.1,
        fromQueue: true,
      },
    });

    await drainQueue(impl);

    const put = calls.find((call) => call.method === "PUT");
    expect(put, "the edit was not sent as an update").toBeDefined();
    expect(put?.url).toBe("/api/weight/row-1");
    expect(put?.body).toMatchObject({ baselineWeightKg: 110, weightKg: 110.1 });

    // Sent means gone from the queue, and no question was recorded.
    expect(await db.mutations.count()).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
  });
});

describe("two creates for one day", () => {
  /**
   * The collision the conflict page is actually about: one device's queued
   * create meets a day another device already wrote.
   */
  async function collide() {
    const { impl } = answering((url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { fromQueue?: boolean }) : {};
      if (url.includes("/api/weight") && body.fromQueue) {
        return {
          status: 409,
          body: {
            error: "day_already_written",
            message: "Den här dagen har redan en vägning från en annan enhet.",
            existing: { localDate: "2026-08-24", weightKg: 110 },
          },
        };
      }
      return { status: 200, body: {} };
    });

    await enqueue({
      kind: "weight",
      timezone: TZ,
      localDate: "2026-08-24",
      body: { localDate: "2026-08-24", weightKg: 108.2, fromQueue: true },
    });

    await drainQueue(impl);
  }

  it("records one question, with both readings and which kind it is", async () => {
    await collide();

    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe("day_already_written");
    expect(conflicts[0]?.theirs).toMatchObject({ weightKg: 110 });
    expect(conflicts[0]?.mine).toMatchObject({ weightKg: 108.2 });
    // And it knows which queued row it came from, so both answers are possible.
    expect(conflicts[0]?.mutationId).toBeDefined();

    const mutations = await db.mutations.toArray();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.status).toBe("conflict");
  });

  /** Answer one: the server's reading stands, and the waiting write is dropped. */
  it("keeping the saved one leaves nothing waiting", async () => {
    await collide();
    const conflict = (await db.conflicts.toArray())[0]!;

    await keepServerReading(conflict.id!);

    expect(await db.mutations.count()).toBe(0);
    expect((await db.conflicts.get(conflict.id!))?.resolvedAt).not.toBeNull();
  });

  /**
   * Answer two: the waiting reading is sent **live**, without `fromQueue`.
   *
   * That is the point of the resolution. D41 refuses a queued write for an
   * occupied day because it was composed before that day existed; once a person
   * has looked at both and chosen, it is a decision made now, and a live write
   * replaces the day.
   */
  it("using the waiting one sends it live, and leaves nothing waiting", async () => {
    await collide();
    const conflict = (await db.conflicts.toArray())[0]!;

    const { impl, calls } = answering(() => ({ status: 200, body: {} }));
    await applyQueuedReading(conflict.id!, impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toMatchObject({ weightKg: 108.2 });
    // The flag is what made it a conflict; the resolution is not one.
    expect(calls[0]?.body).not.toHaveProperty("fromQueue");

    expect(await db.mutations.count()).toBe(0);
    expect((await db.conflicts.get(conflict.id!))?.resolvedAt).not.toBeNull();
  });

  /** A failed resolution changes nothing, so the question can be asked again. */
  it("keeps the question when the network is still gone", async () => {
    await collide();
    const conflict = (await db.conflicts.toArray())[0]!;

    const { impl } = answering(() => ({ status: 503, body: {} }));
    await expect(applyQueuedReading(conflict.id!, impl)).rejects.toThrow();

    expect(await db.mutations.count()).toBe(1);
    expect((await db.conflicts.get(conflict.id!))?.resolvedAt).toBeNull();
  });
});

describe("an edit whose row moved underneath it", () => {
  /**
   * The other collision, and the reason the page needed to say which one it is
   * looking at: "two devices wrote this day" is wrong here.
   */
  it("is recorded as changed_since, with the same two answers available", async () => {
    const { impl } = answering((url) => {
      if (url.startsWith("/api/weight/")) {
        return {
          status: 409,
          body: {
            error: "changed_since",
            message: "Den här vägningen har ändrats någon annanstans.",
            existing: { localDate: "2026-08-24", weightKg: 108.2 },
          },
        };
      }
      return { status: 200, body: {} };
    });

    await enqueue({
      kind: "weight-update",
      timezone: TZ,
      localDate: "2026-08-24",
      body: {
        id: "row-1",
        localDate: "2026-08-24",
        baselineWeightKg: 110,
        weightKg: 110.1,
        fromQueue: true,
      },
    });
    await drainQueue(impl);

    const conflicts = await db.conflicts.toArray();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.reason).toBe("changed_since");
    expect(conflicts[0]?.mutationId).toBeDefined();
  });
});


describe("an edit whose row was deleted while it waited", () => {
  /**
   * The 404 case (D153).
   *
   * The server answers 404 only when the row is gone **and** the day is empty;
   * a gone row on an occupied day is `changed_since`, because a live write
   * replaces the day rather than updating the row. So this is the one shape
   * where nothing on the server disagrees with the waiting reading: there is
   * simply nothing there, and putting it back is a legitimate answer.
   *
   * What this holds is that the queue item does not die. Before, a 404 fell
   * into the generic 4xx branch, `status: "failed"`, and the page offered
   * "Försök igen" — the identical PUT to the identical absent row, forever —
   * beside "Kasta", which throws away a reading somebody took and typed.
   */
  async function deleted() {
    const { impl } = answering((url) => {
      if (url.startsWith("/api/weight/")) {
        return {
          status: 404,
          body: { error: "not_found", message: "Den vägningen finns inte längre." },
        };
      }
      return { status: 200, body: {} };
    });

    await enqueue({
      kind: "weight-update",
      timezone: TZ,
      localDate: "2026-08-24",
      body: {
        id: "row-1",
        localDate: "2026-08-24",
        baselineWeightKg: 110,
        weightKg: 110.1,
        fromQueue: true,
      },
    });

    await drainQueue(impl);
  }

  it("asks the question instead of failing", async () => {
    await deleted();

    const conflicts = await db.conflicts.toArray();
    expect(conflicts, "a deleted row recorded no question").toHaveLength(1);
    expect(conflicts[0]?.reason).toBe("row_gone");
    expect(conflicts[0]?.mine).toMatchObject({ weightKg: 110.1 });
    // Nothing on the server, which is a fact rather than a missing value: the
    // page shows one reading because there is one.
    expect(conflicts[0]?.theirs).toEqual({});
    expect(conflicts[0]?.mutationId).toBeDefined();

    const mutations = await db.mutations.toArray();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.status, "the queued edit was marked failed").toBe("conflict");
    // 404 rather than 409 on the row, which is what lets the inspector say
    // "Raden är borttagen" instead of naming a device that was not involved.
    expect(mutations[0]?.failure?.status).toBe(404);
    expect(mutations[0]?.failure?.code).toBe("not_found");
  });

  /**
   * Answer one: put it back. A create for a day that is now empty, sent live
   * and without `fromQueue`, exactly as the other two resolutions are.
   */
  it("adding it again posts the reading for that day", async () => {
    await deleted();
    const conflict = (await db.conflicts.toArray())[0]!;

    const { impl, calls } = answering(() => ({ status: 200, body: {} }));
    await applyQueuedReading(conflict.id!, impl);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/api/weight");
    expect(calls[0]?.body).toMatchObject({ localDate: "2026-08-24", weightKg: 110.1 });
    // The id it was holding is gone, and so is the baseline that named it.
    // Sending either would address a row that does not exist.
    expect(calls[0]?.body).not.toHaveProperty("id");
    expect(calls[0]?.body).not.toHaveProperty("baselineWeightKg");
    expect(calls[0]?.body).not.toHaveProperty("fromQueue");

    expect(await db.mutations.count()).toBe(0);
    expect((await db.conflicts.get(conflict.id!))?.resolvedAt).not.toBeNull();
  });

  /** Answer two: leave it deleted. The waiting edit goes, and nothing is sent. */
  it("discarding it leaves nothing waiting", async () => {
    await deleted();
    const conflict = (await db.conflicts.toArray())[0]!;

    await keepServerReading(conflict.id!);

    expect(await db.mutations.count()).toBe(0);
    expect((await db.conflicts.get(conflict.id!))?.resolvedAt).not.toBeNull();
  });

  /**
   * A 404 on anything else is still a refusal. Only an update addresses a row;
   * every other kind posts to a collection, where a 404 is a routing fault and
   * a question about which reading to keep would be nonsense.
   */
  it("leaves a 404 on a create as a refusal", async () => {
    const { impl } = answering(() => ({ status: 404, body: { error: "not_found" } }));

    await enqueue({
      kind: "weight",
      timezone: TZ,
      localDate: "2026-08-24",
      body: { localDate: "2026-08-24", weightKg: 108.2, fromQueue: true },
    });
    await drainQueue(impl);

    expect(await db.conflicts.count()).toBe(0);
    expect((await db.mutations.toArray())[0]?.status).toBe("failed");
  });
});
