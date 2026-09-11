import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateHabit, CreateHabitCheck, Habit, HabitList, UpdateHabit } from "shared";
import { api, ApiError } from "./api.js";
import { enqueueAndSync } from "./queue/enqueue.js";
import { DAY_KEY } from "./daily.js";

/**
 * The habit checklist (D137).
 *
 * Two different kinds of write, deliberately handled differently:
 *
 * **Ticking goes through the offline queue.** It is a log row with a
 * `client_uuid` and a client-computed `local_date`, like a weight or a meal,
 * and ticking a habit on a train is the case the queue exists for. The
 * mutation resolves when the tick is *stored*, not when the server has it.
 *
 * **Editing the list does not.** Creating, renaming, reordering and deleting
 * are definitions rather than log rows: there is no `client_uuid` to be
 * idempotent on, a replayed delete is a 404 rather than a no-op, and nobody
 * reorganises their checklist in a tunnel. They are ordinary requests that fail
 * out loud.
 */

export const HABIT_KEY = ["habits"] as const;

export function useHabits() {
  return useQuery({
    queryKey: HABIT_KEY,
    queryFn: () => api.listHabits(),
    select: (data: HabitList) => data.habits,
    staleTime: 30_000,
  });
}

/** Everything that changes the list also changes what Dagen shows. */
function useHabitMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HABIT_KEY });
      void queryClient.invalidateQueries({ queryKey: DAY_KEY });
    },
  });
}

export function useCreateHabit() {
  return useHabitMutation<CreateHabit, Habit>((input) => api.createHabit(input));
}

export function useUpdateHabit() {
  return useHabitMutation<{ id: string; patch: UpdateHabit }, Habit>(({ id, patch }) =>
    api.updateHabit(id, patch),
  );
}

export function useReorderHabits() {
  return useHabitMutation<string[], HabitList>((ids) => api.reorderHabits(ids));
}

/**
 * Removing a habit, with or without its history.
 *
 * `history` is required rather than defaulted here, even though the API
 * defaults it: the caller has just asked somebody which one they meant, and a
 * default at this layer would let a future caller skip asking.
 */
export function useRemoveHabit() {
  return useHabitMutation<{ id: string; history: "keep" | "remove" }, void>(({ id, history }) =>
    api.removeHabit(id, history),
  );
}

/**
 * Ticking and unticking, through the queue.
 *
 * `timezone` is the profile's, so a tick made at 23:50 keeps the day it was
 * made on even if it syncs in the morning (D39).
 */
export function useCheckHabit(timezone = "Europe/Stockholm") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CreateHabitCheck, "clientUuid">) =>
      enqueueAndSync({
        kind: "habit-check",
        timezone,
        localDate: input.localDate,
        body: input,
      }),
    onSuccess: () => {
      // Fired on enqueue; `useQueueSync` fires the same set again once the
      // server actually has the tick, which is the one that moves the streak.
      void queryClient.invalidateQueries({ queryKey: DAY_KEY });
      void queryClient.invalidateQueries({ queryKey: HABIT_KEY });
    },
  });
}

/** Whether an error is the list being full, which has its own sentence. */
export function isHabitLimit(error: unknown): boolean {
  return error instanceof ApiError && error.status === 422;
}
