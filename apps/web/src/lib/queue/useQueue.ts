import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type MutationKind } from "./db.js";
import { drainQueue, onQueueSent } from "./sync.js";
import { INSIGHTS_KEY, INTAKE_KEY, WEIGHT_KEY } from "../log.js";
import { ENTRIES_KEY, RECENT_KEY } from "../food.js";
import {
  ACTIVITY_KEY,
  CORRELATION_KEY,
  DAILY_KEY,
  DAY_KEY,
  MEASUREMENT_KEY,
} from "../daily.js";
import { POT_KEY, PROGRESS_KEY } from "../progress.js";

/**
 * The queue, as the UI sees it.
 *
 * `useLiveQuery` re-renders on any write to IndexedDB, so the sync indicator
 * and the inspector follow the queue without polling and without a store to
 * keep in step with it.
 */

export function useQueueState() {
  const pending = useLiveQuery(
    () => db.mutations.where("status").equals("pending").count(),
    [],
    0,
  );
  const attention = useLiveQuery(
    () => db.mutations.where("status").anyOf("failed", "conflict").count(),
    [],
    0,
  );

  return { pending, attention };
}

export function useQueuedMutations() {
  return useLiveQuery(() => db.mutations.orderBy("id").toArray(), [], []);
}

export function useUnresolvedConflicts() {
  return useLiveQuery(
    () => db.conflicts.filter((row) => row.resolvedAt === null).toArray(),
    [],
    [],
  );
}

/**
 * Whether the browser thinks it has a network.
 *
 * `navigator.onLine` is famously optimistic: it reports a connection to a
 * captive portal, a wifi network with no route out, and a tunnel that has
 * dropped. So it is used only to decide **when to try**, never to decide what
 * to show. What the app shows is driven by whether requests actually succeed,
 * which is the only thing that can be known (D43).
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return online;
}

/**
 * Which cached lists a kind of write makes stale, once the **server** has it.
 *
 * Keyed by mutation kind rather than invalidated wholesale, so sending a weight
 * does not refetch the food log. `DAY_KEY` is on weight as well as food because
 * `GET /api/day` carries the day's weight reading alongside everything else,
 * and the daily screen was showing yesterday's until it was reopened.
 */
const AFFECTED: Record<MutationKind, readonly (readonly string[])[]> = {
  weight: [WEIGHT_KEY, INSIGHTS_KEY, DAY_KEY],
  "manual-intake": [INTAKE_KEY, INSIGHTS_KEY],
  "food-entry": [RECENT_KEY, ENTRIES_KEY, INTAKE_KEY, INSIGHTS_KEY],

  /**
   * The four kinds the queue can carry but nothing enqueues yet: the daily log,
   * measurements, activity and savings offsets all write straight to the API
   * and await the response, so their own `onSuccess` invalidation is already
   * correct. Listed rather than left out so that the day someone routes them
   * through the queue, the compiler asks what they make stale instead of
   * letting them go quiet.
   */
  daily: [DAILY_KEY, DAY_KEY, CORRELATION_KEY],
  measurement: [MEASUREMENT_KEY, DAY_KEY, INSIGHTS_KEY, CORRELATION_KEY],
  activity: [ACTIVITY_KEY, DAY_KEY, CORRELATION_KEY],
  "savings-offset": [PROGRESS_KEY, POT_KEY, DAY_KEY],
};

/** How often the queue is retried while something is waiting. */
const DRAIN_INTERVAL_MS = 30_000;

/**
 * Drains the queue when there is reason to think it might work: on regaining
 * the network, on the tab becoming visible again, and periodically while
 * anything is pending.
 *
 * The interval only runs while there is something to send, so an idle app makes
 * no requests at all.
 */
export function useQueueSync(): void {
  const online = useOnline();
  const { pending } = useQueueState();
  const queryClient = useQueryClient();

  /**
   * Refetch when the server actually has the write, not when the queue accepted
   * it.
   *
   * The mutation hooks invalidate on enqueue too, which is right for the local
   * feedback but races the POST and normally wins: the refetch returns the list
   * without the entry that was just added, and it stays one behind until a
   * manual reload. This is the half that makes the list correct.
   */
  useEffect(
    () =>
      onQueueSent((kinds) => {
        const keys = new Set<readonly string[]>();
        for (const kind of kinds) for (const key of AFFECTED[kind]) keys.add(key);
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      }),
    [queryClient],
  );

  useEffect(() => {
    if (pending === 0) return;

    const attempt = () => void drainQueue().catch(() => {});

    attempt();
    const timer = window.setInterval(attempt, DRAIN_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") attempt();
    };
    window.addEventListener("online", attempt);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", attempt);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pending, online]);
}
