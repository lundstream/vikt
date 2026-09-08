import Dexie, { type Table } from "dexie";

/**
 * The offline write queue.
 *
 * Every mutation is written here first, rendered from here immediately, and
 * sent to the server afterwards. That order is the whole point: a log entry
 * typed in a shop basement is saved the moment it is typed, and the network is
 * something that happens to it later.
 *
 * The server side of this needs nothing new. Every log endpoint has been an
 * idempotent upsert on `(user_id, client_uuid)` since Phase 1 (CLAUDE.md §3),
 * precisely so that this phase could be added without touching them.
 */

/**
 * What a queued mutation is.
 *
 * `localDate` is carried on the row rather than derived at send time, and that
 * is D39: an entry created at 23:50 and synced at 08:00 belongs to the day it
 * was created on. Deriving the day when the request finally leaves would move
 * every late-night entry to the following morning, silently, and only for
 * people who log late — which is most people, some of the time.
 */
export type QueuedMutation = {
  /** Autoincrement. Send order is creation order. */
  id?: number;
  /** The idempotency key. From `lib/uuid.ts` (D18), never `crypto.randomUUID`. */
  clientUuid: string;
  /** Which endpoint this replays against. */
  kind: MutationKind;
  /** The request body, already in the shape the endpoint expects. */
  body: Record<string, unknown>;
  /** `YYYY-MM-DD`, computed when the entry was created. Never recomputed. */
  localDate: string;
  /**
   * Where `localDate` came from (D61).
   *
   * `device` means the client's own day boundary at the moment of creation, the
   * D39 case: an entry made at 23:50 keeps that day even if it syncs at 08:00
   * from another timezone. `chosen` means a person picked the date — they are
   * filling in last Tuesday — which is a *different fact* that happens to be
   * stored in the same column.
   *
   * The queue has never rewritten either at send time. What was missing was any
   * way to tell them apart, which mattered in two places: the inspector could
   * not say whether "28 aug" was a backfill or a stale clock, and a conflict
   * (D41) could not explain which of two devices had deliberately chosen a day.
   *
   * **Optional, and defaulted on read** (D70). Rows written before the field
   * existed do not have it, and the correct answer for those is `device`:
   * until the date selector shipped there was no way for a person to choose a
   * date. Filling them in with a schema upgrade is what caused a hang, so the
   * default lives in `dateSourceOf` instead.
   */
  dateSource?: DateSource;
  /** The IANA zone the entry was created in, for the conflict message. */
  timezone: string;
  /** When it was created, for ordering and for the inspector. */
  createdAt: string;
  status: QueueStatus;
  attempts: number;
  /** When the next attempt may run. Backoff lives here rather than in a timer. */
  nextAttemptAt: string | null;
  /** Set when the server refused it. Shown to the user; the entry is kept. */
  failure: QueueFailure | null;
};

export type DateSource = "device" | "chosen";

export type MutationKind =
  | "weight"
  | "manual-intake"
  | "food-entry"
  | "daily"
  | "measurement"
  | "activity"
  | "savings-offset";

/**
 * `pending` is waiting to be sent, `failed` has been refused and needs a
 * person, `conflict` reached the server but lost to a row written elsewhere.
 *
 * There is no `sent` state: a mutation that succeeds is deleted. Keeping it
 * would make the queue a second copy of the log that has to be kept in step
 * with the first, and the server is the record.
 */
export type QueueStatus = "pending" | "failed" | "conflict";

export type QueueFailure = {
  /** HTTP status, or 0 when the request never reached a server. */
  status: number;
  code: string;
  /** Shown verbatim; the API's messages are already in Swedish. */
  message: string;
  at: string;
};

/**
 * A day that two devices wrote differently (D41).
 *
 * Kept separately from the mutation so that resolving the conflict does not
 * require the mutation to still exist, and so the notice survives a reload.
 */
export type QueueConflict = {
  id?: number;
  kind: MutationKind;
  localDate: string;
  /** What this device had queued. */
  mine: Record<string, unknown>;
  /** What the server had when the queued row arrived. */
  theirs: Record<string, unknown>;
  createdAt: string;
  /** Cleared when the user has chosen. Never auto-resolved. */
  resolvedAt: string | null;
};

class VaktDb extends Dexie {
  mutations!: Table<QueuedMutation, number>;
  conflicts!: Table<QueueConflict, number>;

  constructor() {
    super("vikt-queue");
    /**
     * One version, deliberately (D70).
     *
     * `dateSource` was added with a `version(2)` whose only job was to stamp
     * existing rows, since the field is not indexed and needed no schema
     * change. That upgrade could not run while any other connection held the
     * database at v1 — a second tab, or the installed app beside a browser tab
     * — so `indexedDB.open` fired `blocked` and never settled. `db.open()` was
     * awaited without a timeout, so every log write hung on "Sparar…" forever.
     *
     * A version bump is for indexes. A default is for missing values, and it
     * belongs at the point of reading.
     */
    this.version(1).stores({
      // `++id` keeps send order. `clientUuid` is unique so a double-tap that
      // reuses a key cannot enqueue the same write twice.
      mutations: "++id, &clientUuid, status, kind, localDate, createdAt",
      conflicts: "++id, kind, localDate, resolvedAt",
    });
  }
}

export const db = new VaktDb();

/**
 * Whether IndexedDB is usable at all.
 *
 * Private windows, storage pressure and locked-down browsers all fail here,
 * and the app has to keep working without a queue rather than refusing to log.
 * Callers fall back to sending straight to the network.
 */
/**
 * How long to wait for the database before giving up on it.
 *
 * `db.open()` can legitimately never settle: an upgrade blocked by another
 * connection fires `blocked` and then simply waits. Awaiting that with no bound
 * is what turned a schema change into an app that hangs on save, so the wait is
 * bounded and a queue that will not open is treated the same as one the browser
 * refused (D70).
 */
const OPEN_TIMEOUT_MS = 3000;

export async function queueAvailable(): Promise<boolean> {
  try {
    return await Promise.race([
      db.open().then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), OPEN_TIMEOUT_MS),
      ),
    ]);
  } catch {
    return false;
  }
}

/**
 * A queued row's date provenance, with the historical default.
 *
 * Rows written before the field existed are `device`: until the date selector
 * shipped, nothing in the UI could choose a date.
 */
export function dateSourceOf(mutation: QueuedMutation): DateSource {
  return mutation.dateSource ?? "device";
}
