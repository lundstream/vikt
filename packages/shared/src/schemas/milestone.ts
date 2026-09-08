import { z } from "zod";
import { localDateSchema } from "./log.js";

/**
 * Milestones, rewards and the savings pot.
 *
 * Two shapes here carry a decision rather than just data:
 *
 * `status` is what the milestone list renders, and it distinguishes
 * `raw_reached` from `close` because the EMA's nine-day lag has to be visible
 * rather than silent (D36).
 *
 * `celebrate` is a separate flag from `achievedAt`, because "achieved" and
 * "already celebrated" are two facts and only the pair of them makes a
 * once-only celebration possible (D38).
 */

export const milestoneMetricSchema = z.enum([
  "weight_kg",
  "waist_cm",
  "chest_cm",
  "whtr",
  "log_streak_days",
  "sober_days",
]);
export type MilestoneMetricName = z.infer<typeof milestoneMetricSchema>;

export const createMilestoneSchema = z.object({
  label: z.string().trim().min(1).max(120),
  metric: milestoneMetricSchema,
  targetValue: z.number().min(0).max(1000),
  rewardText: z.string().trim().max(200).nullish(),
  /** Null means the milestone is its own reward. */
  rewardCostSek: z.number().min(0).max(1_000_000).nullish(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export type CreateMilestone = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = createMilestoneSchema.partial();
export type UpdateMilestone = z.infer<typeof updateMilestoneSchema>;

export const milestoneStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("achieved"), achievedAt: z.string() }),
  z.object({
    state: z.literal("raw_reached"),
    rawValue: z.number(),
    trendValue: z.number(),
    remaining: z.number(),
  }),
  z.object({ state: z.literal("close"), remaining: z.number() }),
  z.object({ state: z.literal("open"), remaining: z.number().nullable() }),
]);

export const milestoneSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  metric: milestoneMetricSchema,
  targetValue: z.number(),
  rewardText: z.string().nullable(),
  rewardCostSek: z.number().nullable(),
  sortOrder: z.number(),
  achievedAt: z.string().nullable(),
  achievedValue: z.number().nullable(),
  rewardClaimedAt: z.string().nullable(),
  /** Where it stands today, computed from the trend and the raw series. */
  status: milestoneStatusSchema,
  /** 0 to 1, or null without a starting value to measure from. */
  progress: z.number().min(0).max(1).nullable(),
  /**
   * From `project.ts`, on the same series the dashboard projects. Null when
   * there is not enough movement to project, and rendered neutrally when it
   * slips: a date moving is information, not a warning (§3).
   */
  projectedDate: z.string().nullable(),
  projectedDays: z.number().int().min(0).nullable(),
  /** Whether the pot covers this milestone's reward right now. */
  rewardAffordable: z.boolean().nullable(),
  /** Days at the current savings rate until it is affordable. */
  daysUntilAffordable: z.number().int().min(0).nullable(),
});
export type MilestoneDto = z.infer<typeof milestoneSchema>;

export const milestoneListSchema = z.object({
  milestones: z.array(milestoneSchema),
  /**
   * Achieved but not yet celebrated, at most one at a time. The client shows
   * the moment and then acknowledges it, which is what stops it firing on
   * every dashboard load (D38).
   */
  celebrate: milestoneSchema.nullable(),
});
export type MilestoneList = z.infer<typeof milestoneListSchema>;

/* ------------------------------------------------------------- the savings */

export const cadenceSchema = z.enum([
  "every_day",
  "weekday",
  "weekend_day",
  "per_event",
]);
export type CadenceName = z.infer<typeof cadenceSchema>;

export const createSavingsRuleSchema = z.object({
  label: z.string().trim().min(1).max(120),
  amountSek: z.number().min(0).max(1_000_000),
  cadence: cadenceSchema,
  startDate: localDateSchema,
  endDate: localDateSchema.nullish(),
  active: z.boolean().optional(),
});
export type CreateSavingsRule = z.infer<typeof createSavingsRuleSchema>;

export const updateSavingsRuleSchema = createSavingsRuleSchema.partial();
export type UpdateSavingsRule = z.infer<typeof updateSavingsRuleSchema>;

/**
 * What editing or deleting a rule would do to the pot, asked before it is done.
 *
 * The pot accrues **on read** (§4.5): nothing is written per day, so the balance
 * is recomputed from the rules every time it is shown. That is the right design
 * — it cannot drift out of step with the rules — and it has one consequence
 * that has to be said out loud rather than discovered: changing a rule changes
 * the past. Moving a start date back three months does not adjust the pot going
 * forward, it makes three months of savings appear.
 *
 * So the change is previewed against the same function that computes the real
 * balance, and the user confirms a figure rather than a form.
 */
export const previewSavingsRuleSchema = z.object({
  asOf: localDateSchema,
  /** The proposed fields, or **null to preview deleting the rule**. */
  next: updateSavingsRuleSchema.nullable(),
});
export type PreviewSavingsRule = z.infer<typeof previewSavingsRuleSchema>;

export const savingsRulePreviewSchema = z.object({
  /** The whole pot, now and after. Both, because a delta alone hides the scale. */
  currentBalanceSek: z.number(),
  nextBalanceSek: z.number(),
  /** Positive means the pot grows. Allowed to be zero, and often is. */
  deltaSek: z.number(),
  /** This rule's own contribution, so the change is attributable. */
  currentRuleAccruedSek: z.number(),
  nextRuleAccruedSek: z.number(),
  /** Eligible days before and after, which is usually the real explanation. */
  currentEligibleDays: z.number().int().min(0),
  nextEligibleDays: z.number().int().min(0),
  /** True when the pot would go from covering a claimable reward to not. */
  wouldUnaffordReward: z.boolean(),
});
export type SavingsRulePreviewDto = z.infer<typeof savingsRulePreviewSchema>;

export const savingsRuleSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  amountSek: z.number(),
  cadence: cadenceSchema,
  startDate: z.string(),
  endDate: z.string().nullable(),
  active: z.boolean(),
  /** What it adds per week, so the copy can say how fast the pot fills. */
  weeklyRateSek: z.number(),
  accruedSek: z.number(),
  eligibleDays: z.number().int().min(0),
  offsetDays: z.number().int().min(0),
});
export type SavingsRuleDto = z.infer<typeof savingsRuleSchema>;

/**
 * "I did buy the lunch after all."
 *
 * Keyed on `(rule_id, local_date)`, which is a natural key, so re-sending one
 * is idempotent without needing a `client_uuid` of its own.
 */
export const createOffsetSchema = z.object({
  ruleId: z.string().uuid(),
  localDate: localDateSchema,
  note: z.string().trim().max(200).nullish(),
});
export type CreateOffset = z.infer<typeof createOffsetSchema>;

export const offsetSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  localDate: z.string(),
  note: z.string().nullable(),
});
export type OffsetDto = z.infer<typeof offsetSchema>;

export const createSavingsEventSchema = z.object({
  localDate: localDateSchema,
  label: z.string().trim().min(1).max(120),
  /** Negative draws the pot down. A reward payout is one of these. */
  amountSek: z.number().min(-1_000_000).max(1_000_000),
});
export type CreateSavingsEvent = z.infer<typeof createSavingsEventSchema>;

export const savingsEventSchema = z.object({
  id: z.string().uuid(),
  localDate: z.string(),
  label: z.string(),
  amountSek: z.number(),
  milestoneId: z.string().uuid().nullable(),
});
export type SavingsEventDto = z.infer<typeof savingsEventSchema>;

export const potSchema = z.object({
  asOf: z.string(),
  accruedSek: z.number(),
  eventsSek: z.number(),
  paidOutSek: z.number(),
  /** Allowed to be negative. Shown plainly, never clamped to zero. */
  balanceSek: z.number(),
  weeklyRateSek: z.number(),
  rules: z.array(savingsRuleSchema),
  events: z.array(savingsEventSchema),
  /** Daily balances for the chart that makes the pot visibly climb. */
  series: z.array(z.object({ localDate: z.string(), balanceSek: z.number() })),
});
export type PotDto = z.infer<typeof potSchema>;

/* -------------------------------------------------- streaks and sobriety */

export const soberCountSchema = z.object({
  days: z.number().int().min(0).nullable(),
  lastDrinkOn: z.string().nullable(),
  basis: z.enum(["no_data", "gap", "since_drink", "never_recorded", "seeded"]),
  countingFrom: z.string().nullable(),
  /** Which rule produced the number, so the UI can say so (D35). */
  rule: z.enum(["strict", "assumeSober"]),
});
export type SoberCountDto = z.infer<typeof soberCountSchema>;

export const streakSchema = z.object({
  days: z.number().int().min(0),
  graceUsed: z.number().int().min(0),
  startedOn: z.string().nullable(),
});
export type StreakDto = z.infer<typeof streakSchema>;

export const progressResponseSchema = z.object({
  asOf: z.string(),
  streak: streakSchema,
  sober: soberCountSchema,
  pot: potSchema,
  milestones: z.array(milestoneSchema),
  celebrate: milestoneSchema.nullable(),
});
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

export const asOfQuerySchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional(),
});
