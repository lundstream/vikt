import { ApiError } from "../api.js";
import { db, type MutationKind, type QueuedMutation } from "./db.js";

/**
 * Draining the queue.
 *
 * Four rules, each one a decision recorded in DECISIONS.md.
 *
 * **Replay is normal (D40).** Every endpoint upserts on `(user_id, client_uuid)`,
 * so sending the same mutation twice is one row. That matters most in the case
 * nobody thinks to test: the server committed and the *response* was lost. The
 * client never heard success, retries, and must not create a duplicate.
 *
 * **A rejection is not retried forever (D42).** A 4xx means the server has read
 * it and said no; sending it again changes nothing. It is kept, marked, and put
 * in front of the user with what they typed intact.
 *
 * **A conflict is deterministic and visible (D41).** `weight_log` is unique on
 * `(user_id, local_date)`, so one of two devices wins. The winner is chosen by
 * a stated rule, not by arrival order, and the loser is shown rather than
 * discarded.
 *
 * **Backoff is stored, not timed.** `nextAttemptAt` is a column, so a retry
 * schedule survives a reload, a tab close and the app being killed. A
 * `setTimeout` does not.
 */

export const ENDPOINTS: Record<MutationKind, string> = {
  weight: "/weight",
  // The row's own id goes in the path; see `requestFor` below.
  "weight-update": "/weight",
  "manual-intake": "/manual-intake",
  "food-entry": "/food-entry",
  daily: "/daily",
  measurement: "/measurement",
  activity: "/activity",
  "savings-offset": "/savings/offsets",
  "habit-check": "/habit-check",
};

/**
 * How many times a *transport* failure is retried before the entry is parked.
 *
 * Generous, because the thing being waited out is a tunnel, a lift or a shop
 * basement, and the cost of waiting is nothing. A rejection by the server is
 * not covered by this: that is not retried at all beyond the first attempt.
 */
export const MAX_ATTEMPTS = 8;

/** Exponential, capped. 2s, 4s, 8s ... 5 min. */
export function backoffMs(attempts: number): number {
  return Math.min(2_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
}

export type SyncResult = {
  sent: number;
  failed: number;
  conflicted: number;
  remaining: number;
};

let draining = false;

/**
 * Who to tell when a write actually reaches the server.
 *
 * The queue resolves a mutation as soon as it is **stored locally**, which is
 * the entire point (D39-D42): a meal logged in a shop basement is logged, and
 * the screen must not wait on a network that may not be there. What that broke
 * is the cache: invalidating on enqueue fires a refetch that races the POST and
 * usually wins, so the list came back without the entry that had just been
 * added and stayed exactly one behind until a manual reload.
 *
 * So the refetch is driven from here instead, once per kind that was actually
 * accepted. Online that is one round trip after the tap and invisible; offline
 * it simply does not fire, which is correct, because there is nothing on the
 * server to re-read.
 */
type SentListener = (kinds: readonly MutationKind[]) => void;

const sentListeners = new Set<SentListener>();

export function onQueueSent(listener: SentListener): () => void {
  sentListeners.add(listener);
  return () => sentListeners.delete(listener);
}

/**
 * Send everything that is due, oldest first.
 *
 * Serialised: two drains running at once would send the same mutation twice,
 * which is harmless by D40 but wasteful, and would double-count the results.
 * Order matters too — a food entry logged before a weight should reach the
 * server in that order so the milestone detection on the second sees the first.
 */
export async function drainQueue(
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  if (draining) return { sent: 0, failed: 0, conflicted: 0, remaining: await pendingCount() };
  draining = true;

  const result: SyncResult = { sent: 0, failed: 0, conflicted: 0, remaining: 0 };

  try {
    const now = Date.now();
    const due = (await db.mutations.where("status").equals("pending").sortBy("id")).filter(
      (row) => row.nextAttemptAt === null || Date.parse(row.nextAttemptAt) <= now,
    );

    const sentKinds = new Set<MutationKind>();

    for (const mutation of due) {
      const outcome = await send(mutation, fetchImpl);
      if (outcome === "sent") {
        result.sent += 1;
        sentKinds.add(mutation.kind);
      } else if (outcome === "failed") result.failed += 1;
      else if (outcome === "conflict") result.conflicted += 1;
      // "retry" leaves it pending with a later nextAttemptAt.
    }

    /**
     * After the loop, not inside it. A drain that sends four entries should
     * cause one refetch per affected list, not four.
     */
    if (sentKinds.size > 0) {
      const kinds = [...sentKinds];
      for (const listener of sentListeners) listener(kinds);
    }
  } finally {
    draining = false;
  }

  result.remaining = await pendingCount();
  return result;
}

type Outcome = "sent" | "retry" | "failed" | "conflict";

/**
 * Where a queued mutation is sent, and how (D150).
 *
 * Every kind but one is a POST to a fixed path, which is why this was a lookup
 * table. An update addresses a row, so it is a PUT to that row: the path is the
 * authority on which reading is being changed, and a body that disagreed could
 * not reach a different one.
 */
export function requestFor(mutation: {
  kind: MutationKind;
  body: Record<string, unknown>;
}): { url: string; method: "POST" | "PUT" } {
  if (mutation.kind === "weight-update") {
    const id = String(mutation.body.id ?? "");
    return { url: `/api/weight/${encodeURIComponent(id)}`, method: "PUT" };
  }
  return { url: `/api${ENDPOINTS[mutation.kind]}`, method: "POST" };
}

async function send(
  mutation: QueuedMutation,
  fetchImpl: typeof fetch,
): Promise<Outcome> {
  const attempts = mutation.attempts + 1;

  const target = requestFor(mutation);

  try {
    const response = await fetchImpl(target.url, {
      method: target.method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutation.body),
    });

    if (response.ok) {
      // Succeeded, so the row is gone. The server is the record; keeping a
      // copy here would be a second log to reconcile.
      await db.mutations.delete(mutation.id!);
      return "sent";
    }

    /**
     * 401 is not the entry's fault. The session expired while it sat in the
     * queue, and throwing the entry away would lose data because the user
     * needs to sign in. Left pending, retried after the next sign-in.
     */
    if (response.status === 401) {
      await reschedule(mutation, attempts);
      return "retry";
    }

    const body = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;

    /**
     * 409 is a collision a person has to settle (D41, D150). Two kinds now: two
     * creates for one day, and an edit whose row moved underneath it. Recorded
     * rather than dropped and rather than applied over the top, with which kind
     * it was, because the two read differently on the page.
     */
    if (response.status === 409) {
      await recordConflict(mutation, body);
      return "conflict";
    }

    /**
     * The row an edit is holding is gone, and the day it was on is empty
     * (D153).
     *
     * Not a refusal, and this is the distinction the generic branch below got
     * wrong. The server has read the request and found nothing to change; it
     * has no opinion about the reading itself, and the day is free. Marking
     * that `failed` gave the person "Försök igen", which sends the identical
     * PUT to the identical absent row forever, and "Kasta", which throws away a
     * reading they took and typed. Neither is an answer to the question, and
     * the question has an obvious second answer: put it back.
     *
     * So it becomes the same two-choice shape as a conflict, with one reading
     * instead of two. Only an update can reach this: every other kind posts to
     * a collection, where a 404 is a routing fault and not a missing row.
     */
    if (response.status === 404 && mutation.kind === "weight-update") {
      await recordConflict(mutation, body, "row_gone");
      return "conflict";
    }

    /**
     * Any other 4xx is a considered refusal: a target under the floor, a value
     * out of range. Retrying sends the identical bytes to the identical rule
     * and gets the identical answer, so it stops here and asks a person (D42).
     */
    if (response.status >= 400 && response.status < 500) {
      await db.mutations.update(mutation.id!, {
        status: "failed",
        attempts,
        nextAttemptAt: null,
        failure: {
          status: response.status,
          code: body?.error ?? "rejected",
          message: body?.message ?? "Servern kunde inte spara den här posten.",
          at: new Date().toISOString(),
        },
      });
      return "failed";
    }

    // 5xx: the server's problem, and probably temporary.
    await reschedule(mutation, attempts);
    return "retry";
  } catch (error) {
    // Never reached a server: offline, DNS, a dropped tunnel.
    if (attempts >= MAX_ATTEMPTS) {
      await db.mutations.update(mutation.id!, {
        status: "failed",
        attempts,
        nextAttemptAt: null,
        failure: {
          status: 0,
          code: "unreachable",
          message:
            error instanceof ApiError
              ? error.message
              : "Kunde inte nå servern. Posten är kvar och kan skickas igen.",
          at: new Date().toISOString(),
        },
      });
      return "failed";
    }

    await reschedule(mutation, attempts);
    return "retry";
  }
}

async function reschedule(mutation: QueuedMutation, attempts: number): Promise<void> {
  await db.mutations.update(mutation.id!, {
    attempts,
    nextAttemptAt: new Date(Date.now() + backoffMs(attempts)).toISOString(),
  });
}

async function recordConflict(
  mutation: QueuedMutation,
  body: { error?: string; message?: string } | null,
  /** Given for the 404 case, where the status rather than the body says which. */
  forced?: "row_gone",
): Promise<void> {
  const reason =
    forced ?? (body?.error === "changed_since" ? "changed_since" : "day_already_written");

  await db.conflicts.add({
    kind: mutation.kind,
    localDate: mutation.localDate,
    mine: mutation.body,
    theirs: (body as { existing?: Record<string, unknown> } | null)?.existing ?? {},
    reason,
    // So "use the waiting one" has something to send (D150).
    mutationId: mutation.id,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });

  await db.mutations.update(mutation.id!, {
    status: "conflict",
    nextAttemptAt: null,
    failure: {
      status: reason === "row_gone" ? 404 : 409,
      code: body?.error ?? (reason === "row_gone" ? "not_found" : "conflict"),
      message:
        body?.message ??
        (reason === "row_gone"
          ? "Vägningen du ändrade finns inte längre."
          : "Den här dagen skrevs redan från en annan enhet."),
      at: new Date().toISOString(),
    },
  });
}

export async function pendingCount(): Promise<number> {
  return db.mutations.where("status").equals("pending").count();
}

export async function attentionCount(): Promise<number> {
  return db.mutations.where("status").anyOf("failed", "conflict").count();
}

/**
 * Put a parked entry back in the queue.
 *
 * The user's recovery path for a rejection: correct the value, or simply try
 * again once whatever the server objected to has changed. `attempts` resets,
 * because this is a new decision rather than a continuation of the old one.
 */
export async function retryMutation(id: number): Promise<void> {
  await db.mutations.update(id, {
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    failure: null,
  });
}

/** Discard an entry the user has decided against. Their call, never automatic. */
export async function discardMutation(id: number): Promise<void> {
  await db.mutations.delete(id);
}

/* ------------------------------------------------ settling a conflict (D150) */

/**
 * Two resolutions, and they are equals.
 *
 * The page offered one: "Behåll den som redan finns", which is the shape of a
 * dialog where one answer is really "go away". A conflict is a question with
 * two answers — the reading on the server, or the one waiting on this device —
 * and the person is the only one who knows which is right.
 *
 * Both leave exactly one row, which is what `(user_id, local_date)` guarantees
 * and what makes the choice safe to offer.
 */

/**
 * Keep what the server has. The waiting write is dropped.
 *
 * Where the server has nothing — `row_gone` (D153) — this is the same act with
 * a different name, and the page calls it "Släng den": the reading is not being
 * overruled by another, it is simply not being put back.
 */
export async function keepServerReading(conflictId: number): Promise<void> {
  const row = await db.conflicts.get(conflictId);
  if (row?.mutationId !== undefined) await db.mutations.delete(row.mutationId);
  await db.conflicts.update(conflictId, { resolvedAt: new Date().toISOString() });
}

/**
 * Use the one waiting on this device.
 *
 * Sent **live**, without `fromQueue`, which is the whole point: D41 refuses a
 * queued write for an occupied day precisely because it was composed before
 * that day existed. Once a person has looked at both and chosen, it is no
 * longer a write from the past — it is a decision made now, and a live write
 * replaces the day.
 *
 * An update is re-sent as a create for the same reason. Its baseline is stale
 * by definition, since the row is what moved; re-checking it would refuse the
 * answer the person just gave. In the `row_gone` case it is stale in the
 * strongest sense available, because the row it named does not exist, and a
 * create for an empty day is exactly what "put it back" means (D153).
 */
/**
 * The same two answers, reached from the queue row rather than from the
 * conflict row (D150).
 *
 * They are the same conflict seen from two places: the inspector lists the
 * mutation, the section above lists the question. A person standing at either
 * one should be able to settle it without hunting for the other.
 */
export async function keepServerForMutation(mutationId: number): Promise<void> {
  const row = await db.conflicts.filter((c) => c.mutationId === mutationId).first();
  if (row?.id !== undefined) return keepServerReading(row.id);

  // A conflicted mutation with no recorded question: nothing to compare, so
  // keeping the server's is simply dropping this one.
  await db.mutations.delete(mutationId);
}

export async function applyQueuedForMutation(
  mutationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const row = await db.conflicts.filter((c) => c.mutationId === mutationId).first();
  if (row?.id !== undefined) return applyQueuedReading(row.id, fetchImpl);
}

export async function applyQueuedReading(
  conflictId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const row = await db.conflicts.get(conflictId);
  if (!row) return;

  const { fromQueue: _fromQueue, id: _id, baselineWeightKg: _baseline, ...body } = row.mine as {
    fromQueue?: boolean;
    id?: string;
    baselineWeightKg?: number;
    [key: string]: unknown;
  };

  const response = await fetchImpl("/api/weight", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new ApiError(
      response.status,
      "conflict_unresolved",
      "Kunde inte spara den väntande vägningen. Försök igen när du har täckning.",
    );
  }

  if (row.mutationId !== undefined) await db.mutations.delete(row.mutationId);
  await db.conflicts.update(conflictId, { resolvedAt: new Date().toISOString() });
}
