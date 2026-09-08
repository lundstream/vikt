import { z } from "zod";
import { localDateSchema } from "./log.js";

/**
 * Plans.
 *
 * The target intake is what the user sets. The **rate is derived** from it
 * against the current maintenance figure and returned read-only: the two were
 * independent fields and had already drifted apart, with every projection using
 * the deficit and the stored rate affecting nothing (D27).
 *
 * A plan cannot be saved before a weight has been logged, because neither
 * guardrail can run without one (D28).
 */

export const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(80),
  startDate: localDateSchema,
  endDate: localDateSchema.nullish(),
  startWeightKg: z.number().min(20).max(400).nullish(),
  goalWeightKg: z.number().min(20).max(400).nullish(),
  targetIntakeKcal: z.number().int().min(0).max(20000),
  proteinFloorG: z.number().int().min(0).max(500).nullish(),
  /**
   * The user's own floor. It may only ever *raise* the limit: the server takes
   * `max(systemFloor, this)`, so setting it below the system floor changes
   * nothing. See guardrails.ts.
   */
  intakeFloorKcal: z.number().int().min(0).max(20000),
});
export type CreatePlan = z.infer<typeof createPlanSchema>;

export const updatePlanSchema = createPlanSchema.partial();
export type UpdatePlan = z.infer<typeof updatePlanSchema>;

export const planSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.enum(["active", "archived"]),
  startDate: z.string(),
  endDate: z.string().nullable(),
  startWeightKg: z.number().nullable(),
  goalWeightKg: z.number().nullable(),
  targetIntakeKcal: z.number(),
  /**
   * Derived on the server from the target against maintenance, never sent by
   * the client. Read-only here; see D27.
   */
  targetRateKgWeek: z.number().nullable(),
  proteinFloorG: z.number().nullable(),
  intakeFloorKcal: z.number(),
  /** Maintenance this plan was last validated against, if any (D25). */
  tdeeAtWrite: z.number().nullable(),
  tdeeSourceAtWrite: z.enum(["adaptive", "formula", "none"]).nullable(),
  createdAt: z.string(),
});
export type Plan = z.infer<typeof planSchema>;

export const planListSchema = z.object({ plans: z.array(planSchema) });
export type PlanList = z.infer<typeof planListSchema>;
