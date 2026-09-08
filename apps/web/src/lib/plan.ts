import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatePlan, Plan, UpdatePlan } from "shared";
import { api } from "./api.js";
import { INSIGHTS_KEY } from "./log.js";

export const PLAN_KEY = ["plan", "active"] as const;

export function useActivePlan() {
  return useQuery({
    queryKey: PLAN_KEY,
    queryFn: () => api.activePlan(),
    staleTime: 30_000,
  });
}

/** Creates the plan the first time, updates it after. */
export function useSavePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, input }: { planId: string | null; input: CreatePlan }) =>
      planId === null ? api.createPlan(input) : api.updatePlan(planId, input as UpdatePlan),
    onSuccess: (plan: Plan) => {
      queryClient.setQueryData(PLAN_KEY, plan);
      // The target and the goal both feed the projections.
      void queryClient.invalidateQueries({ queryKey: INSIGHTS_KEY });
    },
  });
}
