import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateActivity,
  CreateDailyLog,
  CreateMeasurement,
} from "shared";
import { api } from "./api.js";
import { INSIGHTS_KEY } from "./log.js";

/**
 * Phase 4 queries: measurements, the daily log, activity and the scatter view.
 *
 * Like weight, these are fetched unbounded and windowed in the browser — a
 * decade of daily rows is smaller than the bundle, and holding the whole series
 * means the EMA on the waist is seeded from the real first measurement rather
 * than from the left edge of whatever range is showing (CLAUDE.md §2).
 */

export const DAY_KEY = ["day"] as const;
export const MEASUREMENT_KEY = ["measurement"] as const;
export const DAILY_KEY = ["daily"] as const;
export const ACTIVITY_KEY = ["activity"] as const;
export const CORRELATION_KEY = ["correlations"] as const;

/**
 * Everything already logged for one day, in one request.
 *
 * The daily screen opens filled in rather than blank, because logging a day is
 * mostly *amending* it — sleep in the morning, energy at night — and a blank
 * form on the second visit means retyping what is already there.
 */
export function useDayLog(localDate: string) {
  return useQuery({
    queryKey: [...DAY_KEY, localDate],
    queryFn: () => api.dayLog(localDate),
    staleTime: 30_000,
  });
}

export function useMeasurements() {
  return useQuery({
    queryKey: MEASUREMENT_KEY,
    queryFn: () => api.listMeasurements(),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

export function useDailyLogs() {
  return useQuery({
    queryKey: DAILY_KEY,
    queryFn: () => api.listDailyLogs(),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

export function useActivities() {
  return useQuery({
    queryKey: ACTIVITY_KEY,
    queryFn: () => api.listActivities(),
    select: (data) => data.entries,
    staleTime: 30_000,
  });
}

export function useCorrelations(asOf: string) {
  return useQuery({
    queryKey: [...CORRELATION_KEY, asOf],
    queryFn: () => api.correlations(asOf),
    staleTime: 60_000,
  });
}

/** The day table under Data (D167). */
export function useDayTable(from: string, to: string) {
  return useQuery({
    queryKey: ["day-table", from, to],
    queryFn: () => api.dayTable(from, to),
    staleTime: 60_000,
  });
}

/** What the CSV export offers, from the API rather than a list kept here. */
export function useExportTables() {
  return useQuery({
    queryKey: ["export", "tables"],
    queryFn: () => api.exportTables(),
    staleTime: Infinity,
  });
}

/**
 * Every mutation is an idempotent upsert keyed on `clientUuid`, so a retry
 * after a flaky connection is safe. Phase 6 swaps the direct call for the Dexie
 * queue without changing the endpoint contract.
 */
function useDayMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
  keys: readonly (readonly string[])[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: DAY_KEY });
      void queryClient.invalidateQueries({ queryKey: CORRELATION_KEY });
    },
  });
}

/**
 * A waist reading moves the waist-to-height series on the dashboard chart, so
 * this invalidates insights too — that series is computed on the server from
 * the same smoother the trend line uses (D32).
 */
export function useSaveMeasurement() {
  return useDayMutation<CreateMeasurement, unknown>(
    (input) => api.saveMeasurement(input),
    [MEASUREMENT_KEY, INSIGHTS_KEY],
  );
}

export function useSaveDailyLog() {
  return useDayMutation<CreateDailyLog, unknown>(
    (input) => api.saveDailyLog(input),
    [DAILY_KEY],
  );
}

/**
 * Activity does **not** invalidate insights, and that is not an oversight: no
 * number on the dashboard depends on it. MET estimates are kept out of every
 * calculation feeding maintenance or the projections (D33).
 */
export function useSaveActivity() {
  return useDayMutation<CreateActivity, unknown>(
    (input) => api.saveActivity(input),
    [ACTIVITY_KEY],
  );
}

/**
 * Removes a whole day's ratings. The day becomes **unlogged**, not zeroed:
 * absent stays absent in the sober counter, the streak and the scatter view.
 */
export function useDeleteDailyLog() {
  return useDayMutation<string, void>((id) => api.deleteDailyLog(id), [DAILY_KEY]);
}

/**
 * Removing a day's measurement (D56, closed).
 *
 * Invalidates insights as well as the measurement list, for the same reason the
 * save does: the waist-to-height series on the dashboard chart is computed on
 * the server from these rows (D32), so a removed reading moves a line on
 * another screen.
 */
export function useDeleteMeasurement() {
  return useDayMutation<string, void>(
    (id) => api.deleteMeasurement(id),
    [MEASUREMENT_KEY, INSIGHTS_KEY],
  );
}

export function useDeleteActivity() {
  return useDayMutation<string, void>((id) => api.deleteActivity(id), [ACTIVITY_KEY]);
}
