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
  "manual-intake": "/manual-intake",
  "food-entry": "/food-entry",
  daily: "/daily",
  measurement: "/measurement",
  activity: "/activity",
  "savings-offset": "/savings/offsets",
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

async function send(
  mutation: QueuedMutation,
  fetchImpl: typeof fetch,
): Promise<Outcome> {
  const attempts = mutation.attempts + 1;

  try {
    const response = await fetchImpl(`/api${ENDPOINTS[mutation.kind]}`, {
      method: "POST",
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
     * 409 is the day already written by another device (D41). Recorded as a
     * conflict for the user to settle, not silently dropped and not silently
     * applied over the top.
     */
    if (response.status === 409) {
      await recordConflict(mutation, body);
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
): Promise<void> {
  await db.conflicts.add({
    kind: mutation.kind,
    localDate: mutation.localDate,
    mine: mutation.body,
    theirs: (body as { existing?: Record<string, unknown> } | null)?.existing ?? {},
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  });

  await db.mutations.update(mutation.id!, {
    status: "conflict",
    nextAttemptAt: null,
    failure: {
      status: 409,
      code: body?.error ?? "conflict",
      message: body?.message ?? "Den här dagen skrevs redan från en annan enhet.",
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
