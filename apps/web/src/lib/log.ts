import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateManualIntake, CreateWeightEntry, UpdateWeightEntry } from "shared";
import { api } from "./api.js";
import { DAY_KEY } from "./daily.js";
import { enqueueAndSync } from "./queue/enqueue.js";

/**
 * Weight and intake queries.
 *
 * Everything is fetched unbounded and windowed in the browser. At one reading a
 * day, a decade of logging is 3,650 rows — smaller than the JS bundle — and
 * holding the whole series means the range selector is instant and the EMA is
 * seeded from the real first reading rather than from whatever happens to be at
 * the left edge of the current window. Revisit if a chart ever exceeds ~2k
 * points (CLAUDE.md §2).
 */

export const WEIGHT_KEY = ["weight"] as const;
export const INTAKE_KEY = ["manual-intake"] as const;
export const INSIGHTS_KEY = ["insights"] as const;

/**
 * Maintenance, target and both projections, all computed by the shared calc
 * functions on the server. The client does not recompute them — one definition
 * of every derived number, per CLAUDE.md §2.
 */
export function useInsights(asOf: string) {
  return useQuery({
    queryKey: [...INSIGHTS_KEY, asOf],
    queryFn: () => api.insights(asOf),
    staleTime: 30_000,
  });
}

export function useWeightLog() {
  return useQuery({
    queryKey: WEIGHT_KEY,
    queryFn: () => api.listWeight(),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

/**
 * The resolved intake series for a window, for the data viewer.
 *
 * Server-resolved: a day's intake is the manual row if there is one, otherwise
 * that day's food entries, otherwise absent, and that rule has exactly one
 * implementation (D44).
 */
export function useIntakeSeries(from: string, to: string) {
  return useQuery({
    queryKey: [...INTAKE_KEY, "series", from, to],
    queryFn: () => api.intakeSeries(from, to),
    select: (data) => data.days,
    staleTime: 30_000,
  });
}

export function useManualIntakeLog() {
  return useQuery({
    queryKey: INTAKE_KEY,
    queryFn: () => api.listManualIntake(),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

/**
 * Both writes go through the offline queue: saved locally first, sent after.
 *
 * The endpoint contract did not change to allow this. Every log endpoint has
 * upserted on `(user_id, client_uuid)` since Phase 1 (§3), which is exactly why
 * the queue could be added in Phase 6 without touching the server.
 *
 * The mutation resolves as soon as the entry is *stored*, not when the server
 * has it. That is the whole point: a weight logged in a lift is logged, and the
 * screen must say so immediately rather than spinning until the doors open.
 */
export function useSaveWeight(timezone = "Europe/Stockholm") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWeightEntry) =>
      enqueueAndSync({
        kind: "weight",
        timezone,
        localDate: input.localDate,
        clientUuid: input.clientUuid,
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WEIGHT_KEY });
      // A new reading moves the trend, which moves everything downstream.
      void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
      // `GET /api/day` carries the day's reading, so the daily screen is stale
      // too. This fires on enqueue; `useQueueSync` fires the same set again
      // once the server actually has it, which is the one that has the entry.
      void queryClient.invalidateQueries({ queryKey: DAY_KEY });
    },
  });
}

/**
 * Changing a reading that exists (D150).
 *
 * Queued like the create, and for the same reason: an edit made on a train has
 * to survive the tunnel. What differs is the **kind**, which decides the method
 * and the path, and the baseline it carries, which is what lets the server tell
 * an edit arriving late from two devices disagreeing about a day.
 */
export function useUpdateWeight(timezone = "Europe/Stockholm") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateWeightEntry) =>
      enqueueAndSync({
        kind: "weight-update",
        timezone,
        localDate: input.localDate,
        clientUuid: input.clientUuid,
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WEIGHT_KEY });
      void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
      void queryClient.invalidateQueries({ queryKey: DAY_KEY });
    },
  });
}

/**
 * Removing a reading.
 *
 * Not queued: a delete has no `client_uuid` to be idempotent on, and replaying
 * one against a row that is already gone is a 404 rather than a no-op. It is
 * also not the offline-critical path the queue exists for, which is logging.
 */
export function useDeleteWeight() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWeight(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WEIGHT_KEY });
      // The trend, both projections and maintenance all move.
      void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
    },
  });
}

/**
 * Not queued, unlike the writes below.
 *
 * The offline queue replays *creates*, which are idempotent on `client_uuid`.
 * A delete is not: replaying one against a row that has since been re-entered
 * would remove the new figure too. So this needs the network, and the UI says
 * so rather than promising something it cannot keep (D42).
 */
export function useDeleteManualIntake() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteManualIntake(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INTAKE_KEY });
      void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
    },
  });
}

export function useSaveManualIntake(timezone = "Europe/Stockholm") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateManualIntake) =>
      enqueueAndSync({
        kind: "manual-intake",
        timezone,
        localDate: input.localDate,
        clientUuid: input.clientUuid,
        body: input,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: INTAKE_KEY });
      void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
    },
  });
}
