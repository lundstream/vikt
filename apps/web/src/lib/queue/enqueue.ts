import {
  db,
  queueAvailable,
  type DateSource,
  type MutationKind,
  type QueuedMutation,
} from "./db.js";
import { drainQueue, ENDPOINTS } from "./sync.js";
import { ApiError } from "../api.js";
import { clientUuid } from "../uuid.js";
import { toLocalDate } from "../dates.js";

/**
 * Writing a mutation: locally first, network second.
 *
 * The order is the feature. A meal logged in a shop basement is saved the
 * moment it is typed; the request is something that happens to it afterwards,
 * possibly much later, possibly on a different network.
 *
 * Two properties are fixed here and tested:
 *
 * **`localDate` is stamped at creation (D39).** Not at send time, and never
 * derived on the server. An entry created at 23:50 and synced at 08:00 keeps
 * the day it was created on; so does one created in Stockholm and synced in
 * Tokyo.
 *
 * **`clientUuid` comes from the D18 helper.** Not `crypto.randomUUID`, which is
 * secure-context only and is `undefined` on exactly the device this queue
 * exists for.
 */

/**
 * How long any single step of a save may take before it is called a failure.
 *
 * Two different budgets, because the two steps have very different honest
 * durations. Writing a row to IndexedDB is single-digit milliseconds on every
 * device that works at all, so five seconds is not a deadline, it is a
 * declaration that something has stopped. A network POST on a phone on mobile
 * data legitimately takes seconds, so it gets twenty and an abort.
 *
 * The reason for having them at all is that **an unbounded await is a lie**.
 * Before this, a stalled step left the mutation pending forever: the button sat
 * on "Sparar…" with no message, no retry and no way back, and because React
 * Query's pending state is shared by every row using the mutation, the rest of
 * the list went dead with it. §3 has no failure state, but it does not permit a
 * *hidden* one, and D42's rule is that a write the app could not make is
 * something the app says out loud.
 */
export const STORE_TIMEOUT_MS = 5000;
export const SEND_TIMEOUT_MS = 20000;

/** Raised when a step stops answering. Carries which step, for the log. */
export class SaveStalled extends Error {
  constructor(readonly step: "queue" | "send") {
    super(`save stalled at ${step}`);
    this.name = "SaveStalled";
  }
}

/**
 * A promise with a deadline.
 *
 * The underlying promise is not cancelled, because IndexedDB requests cannot
 * be. What changes is that the caller stops waiting, which is the part the user
 * can see.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  step: "queue" | "send",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SaveStalled(step)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type EnqueueInput = {
  kind: MutationKind;
  /** Everything except `clientUuid` and `localDate`, which are added here. */
  body: Record<string, unknown>;
  timezone: string;
  /**
   * A date the user picked, for filling in a past day (D61).
   *
   * Passing this is what makes the entry `chosen` rather than `device`: the two
   * are the same column and different facts, and only the caller knows which
   * one it holds. Absent means the client's own day boundary is the answer.
   */
  localDate?: string;
  /** Reuse an existing key, to amend a row rather than add one. */
  clientUuid?: string;
  /**
   * The moment of creation. Injected rather than read from the clock, for the
   * same reason every function in `calc/` takes `asOf`: a unit that reads the
   * clock cannot be tested across a midnight boundary, and midnight is exactly
   * the case D39 is about. Faking the clock globally is not an option here,
   * because IndexedDB's own transactions need real timers to settle.
   */
  now?: Date;
};

/**
 * Whether the local queue has been found unwritable in this session (D118).
 *
 * Set when a queue write times out, and never cleared: a store that stalled
 * once will stall again, and paying `STORE_TIMEOUT_MS` on every subsequent tap
 * would turn one five-second failure into five seconds per log. A reload
 * re-tests it, which is the right granularity — whatever wedged the store is
 * not going to be fixed between two taps.
 */
let queueBroken = false;

/** For the screens that have to say offline logging is not working. */
export function queueDegraded(): boolean {
  return queueBroken;
}

/** Tests only: the flag is module-scope and would leak between cases. */
export function resetQueueHealth(): void {
  queueBroken = false;
}

/**
 * Sends a mutation straight to the server, with no queue behind it.
 *
 * Extracted so the two callers below are provably the same path. One is the
 * case where IndexedDB was never available; the other is the case where it was
 * available and then would not accept a write. They must behave identically,
 * and the surest way to make sure of that is for there to be one of them.
 *
 * The error is thrown rather than swallowed. There is no queue to park it in
 * and no later attempt to make, so the only honest thing is to let the screen
 * say it did not save (D42).
 */
async function sendDirect(kind: MutationKind, body: unknown): Promise<void> {
  const response = await withTimeout(
    fetch(`/api${ENDPOINTS[kind]}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Aborted as well as raced, so a stalled request is actually released
      // rather than left running against a socket nobody is reading.
      signal: abortAfter(SEND_TIMEOUT_MS),
    }),
    SEND_TIMEOUT_MS,
    "send",
  );

  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new ApiError(
      response.status,
      parsed?.error ?? "unknown",
      parsed?.message ?? `Request failed (${response.status})`,
    );
  }
}

export type EnqueueResult = {
  clientUuid: string;
  localDate: string;
  dateSource: DateSource;
  /** False when IndexedDB is unavailable and the write went straight out. */
  queued: boolean;
};

/**
 * Queue a mutation and try to send it immediately.
 *
 * The send is deliberately not awaited by the caller's UI path: the entry is
 * already saved, so the screen can show it at once and the network catches up.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const now = input.now ?? new Date();
  const deviceDate = toLocalDate(now, input.timezone);
  const localDate = input.localDate ?? deviceDate;

  /**
   * A supplied date that happens to equal today is still `device`.
   *
   * The screens pass their selected date on every write, and on most days that
   * date *is* today; calling those "chosen" would make the distinction useless
   * by making almost everything chosen. What marks a backfill is that the date
   * differs from the boundary the device would have computed.
   */
  const dateSource: DateSource = localDate === deviceDate ? "device" : "chosen";
  const uuid = input.clientUuid ?? clientUuid();

  const mutation: QueuedMutation = {
    clientUuid: uuid,
    kind: input.kind,
    body: { ...input.body, clientUuid: uuid, localDate, dateSource },
    localDate,
    dateSource,
    timezone: input.timezone,
    createdAt: now.toISOString(),
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    failure: null,
  };

  /**
   * No usable queue: a private window, storage the browser will not grant, a
   * database that will not open, or one already found unwritable in this
   * session. Logging still has to work, so the write goes straight out and
   * simply is not resilient.
   *
   * It **is actually sent** (D70). This branch used to return without writing
   * anywhere and without a request, on the strength of a comment saying the
   * write went out; nothing did. Every entry made without a queue was silently
   * discarded, which is the worst failure this app has, and it was invisible
   * because the branch was almost never taken.
   */
  if (queueBroken || !(await queueAvailable())) {
    await sendDirect(input.kind, mutation.body);
    return { clientUuid: uuid, localDate, dateSource, queued: false };
  }

  /**
   * Re-queueing the same key replaces the queued body rather than adding a
   * second row. Amending an entry that has not synced yet is one pending
   * write, not two, and the unique index on `clientUuid` would reject the
   * second anyway.
   */
  try {
    await withTimeout(
      (async () => {
        const existing = await db.mutations.where("clientUuid").equals(uuid).first();
        if (existing?.id !== undefined) {
          await db.mutations.update(existing.id, {
            body: mutation.body,
            status: "pending",
            attempts: 0,
            nextAttemptAt: null,
            failure: null,
          });
        } else {
          await db.mutations.add(mutation);
        }
      })(),
      STORE_TIMEOUT_MS,
      "queue",
    );
  } catch (error) {
    /**
     * The store opened and then would not take a row (D118).
     *
     * `queueAvailable()` asks whether the database **opens**, and on the phone
     * this was found on it opened in 1 ms while a single `add` never completed
     * and the server answered a health check in 115 ms. So the app refused to
     * log, told the owner to restart it, and restarting did not help — with a
     * working server the whole time and a fallback already written, tested and
     * sitting one branch above, unreachable because the wrong question had
     * been asked.
     *
     * Opening is not the property that matters. Being able to write is, and
     * there is no way to test that except by writing, so the fallback belongs
     * here rather than in a better `queueAvailable()`.
     *
     * Only `SaveStalled`. A `ConstraintError` from the unique index on
     * `clientUuid` is a real conflict and means something quite different, and
     * swallowing every error here would turn a bug into a silent direct send.
     */
    if (!(error instanceof SaveStalled)) throw error;

    queueBroken = true;
    await sendDirect(input.kind, mutation.body);
    return { clientUuid: uuid, localDate, dateSource, queued: false };
  }

  return { clientUuid: uuid, localDate, dateSource, queued: true };
}

/**
 * A queued write, sent when possible.
 *
 * `queueMode` on the body is what tells the server this write comes from the
 * past: it arrived into a present it has not seen, so a day already written by
 * another device is a conflict to surface rather than a row to overwrite (D41).
 * An ordinary online write does not set it, because there the user is acting on
 * state they can see.
 */
export async function enqueueAndSync(input: EnqueueInput): Promise<EnqueueResult> {
  const result = await enqueue({
    ...input,
    body: { ...input.body, fromQueue: true },
  });

  // Not awaited: the entry is saved, the screen can move on.
  void drainQueue().catch(() => {
    // Failures are recorded on the rows themselves; there is nothing useful to
    // do with a rejected promise here, and an unhandled one is noise.
  });

  return result;
}

/**
 * An abort signal that fires after `ms`, where the platform has one.
 *
 * `AbortSignal.timeout` is recent enough that the phones this app is used on
 * are exactly the population that might lack it, and a missing signal must not
 * take the request down with it: the race above still bounds the wait, the
 * request is simply left to finish into nothing.
 */
function abortAfter(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined") return undefined;
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);

  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
