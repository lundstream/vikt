import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateMilestone,
  UpdateMilestone,
  CreateOffset,
  CreateSavingsEvent,
  CreateSavingsRule,
  PreviewSavingsRule,
  UpdateSavingsRule,
} from "shared";
import { api } from "./api.js";
import { DAY_KEY } from "./daily.js";

/**
 * Milestones, rewards and the savings pot.
 *
 * The pot is accrued on read (D7), so there is nothing to keep in sync: every
 * fetch recomputes it from the rules, offsets and events. That also means any
 * write which could move it simply invalidates this key.
 */

export const PROGRESS_KEY = ["progress"] as const;
export const POT_KEY = ["pot"] as const;

export function useProgress(asOf: string) {
  return useQuery({
    queryKey: [...PROGRESS_KEY, asOf],
    queryFn: () => api.progress(asOf),
    staleTime: 30_000,
  });
}

function useProgressMutation<TInput, TResult>(
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROGRESS_KEY });
      void queryClient.invalidateQueries({ queryKey: POT_KEY });
      // An offset changes what the daily screen shows as already filed.
      void queryClient.invalidateQueries({ queryKey: DAY_KEY });
    },
  });
}

export function useCreateMilestone() {
  return useProgressMutation<CreateMilestone, { id: string }>((input) =>
    api.createMilestone(input),
  );
}

export function useUpdateMilestone() {
  return useProgressMutation<{ id: string; input: UpdateMilestone }, { id: string }>(
    ({ id, input }) => api.updateMilestone(id, input),
  );
}

export function useDeleteMilestone() {
  return useProgressMutation<string, void>((id) => api.deleteMilestone(id));
}

/**
 * Acknowledge the celebration.
 *
 * This is what makes it fire once rather than on every dashboard load (D38):
 * the server stamps `celebrated_at`, a column that exists precisely so that
 * "achieved" and "already shown" can be two separate facts.
 */
export function useAcknowledgeCelebration() {
  return useProgressMutation<string, void>((id) => api.acknowledgeCelebration(id));
}

export function useClaimReward(asOf: string) {
  return useProgressMutation<string, unknown>((id) => api.claimReward(id, asOf));
}

export function useCreateSavingsRule() {
  return useProgressMutation<CreateSavingsRule, { id: string }>((input) =>
    api.createSavingsRule(input),
  );
}

export function useUpdateSavingsRule() {
  return useProgressMutation<{ id: string; input: UpdateSavingsRule }, { id: string }>(
    ({ id, input }) => api.updateSavingsRule(id, input),
  );
}

export function useDeleteSavingsRule() {
  return useProgressMutation<string, void>((id) => api.deleteSavingsRule(id));
}

/**
 * What a change would do to the pot, asked before it is made.
 *
 * A mutation rather than a query, even though it writes nothing: it is called
 * in response to a tap, its answer must never be served from cache, and the
 * pending state is the thing the confirm button waits on.
 */
export function usePreviewSavingsRule() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: PreviewSavingsRule }) =>
      api.previewSavingsRule(id, input),
  });
}

export function useCreateSavingsEvent() {
  return useProgressMutation<CreateSavingsEvent, unknown>((input) =>
    api.createSavingsEvent(input),
  );
}

export function useSaveOffset() {
  return useProgressMutation<CreateOffset, void>((input) => api.saveOffset(input));
}

export function useRemoveOffset() {
  return useProgressMutation<{ ruleId: string; localDate: string }, void>((input) =>
    api.removeOffset(input.ruleId, input.localDate),
  );
}
