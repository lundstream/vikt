import { z } from "zod";

/**
 * `GET /api/insights` — everything the dashboard needs to show maintenance,
 * the daily target and the two projections.
 *
 * Every number here comes out of `packages/shared/src/calc/`. The server
 * assembles rows and calls those functions; it does not reimplement a formula,
 * and neither does the client. That is the whole reason the math lives in a
 * shared package (CLAUDE.md §2).
 */

export const projectionSchema = z.object({
  daysToGoal: z.number().int().min(0),
  targetDate: z.string(),
  alreadyThere: z.boolean(),
});
export type ProjectionDto = z.infer<typeof projectionSchema>;

export const maintenanceSchema = z.object({
  /** kcal/day, or null when `source` is `"none"` (D20). */
  tdee: z.number().nullable(),
  source: z.enum(["adaptive", "formula", "none"]),
  windowDays: z.number().int().min(0),
  coverage: z.number().min(0).max(1),
  /**
   * How much of the window's logged energy was estimated rather than measured
   * (D82). Shown on the screen that shows the maintenance figure, because a
   * number computed largely from guesses is still a real number and the reader
   * is entitled to know which kind they are looking at.
   */
  estimateShare: z.number().min(0).max(1).default(0),
  /** 0-1, shown to the user. Never used in arithmetic. See D19. */
  confidence: z.number().min(0).max(1),
  /** Profile fields to ask for. Only non-empty when `source` is `"none"`. */
  missing: z.array(z.enum(["sex", "birthDate", "heightCm", "weightKg"])),
  daysUntilAdaptive: z.number().int().min(0).nullable(),
  blockedBy: z.enum(["history", "coverage"]).nullable(),
});
export type Maintenance = z.infer<typeof maintenanceSchema>;

export const guardrailViolationSchema = z.object({
  code: z.enum([
    "intake_below_system_floor",
    "intake_below_floor",
    "rate_too_fast",
    "no_weight_reading",
  ]),
  message: z.string(),
  field: z.enum(["targetIntakeKcal", "targetRateKgWeek", "weightKg"]),
});

export const planReviewSchema = z.object({
  reason: z.enum(["source_improved", "tdee_moved"]),
  previousTdee: z.number().nullable(),
  currentTdee: z.number(),
  /** kg per week the plan implies against the *current* maintenance figure. */
  impliedRateKgWeek: z.number(),
  plannedRateKgWeek: z.number().nullable(),
  violations: z.array(guardrailViolationSchema),
});
export type PlanReviewDto = z.infer<typeof planReviewSchema>;

/**
 * Whether logged exercise may raise today's target, and why (D31).
 *
 * `available` is false whenever maintenance is adaptive — that figure already
 * contains the training, so adding it again double-counts it. The UI shows
 * which case is in force rather than a switch whose behaviour is invisible.
 */
export const exerciseAdjustmentSchema = z.object({
  available: z.boolean(),
  inForce: z.boolean(),
  preference: z.boolean(),
  reason: z.enum(["adaptive_includes_activity", "no_maintenance_figure", "formula"]),
});
export type ExerciseAdjustmentDto = z.infer<typeof exerciseAdjustmentSchema>;

/* ------------------------------------------------------------ macros (D52) */

export type MacroKey = "protein" | "carbs" | "fat" | "fiber";

/**
 * One macro: what the reference says, what was eaten, and how much of the day
 * that figure actually covers.
 *
 * `targetG` and `overridden` travel together so the UI can show a number the
 * user set without pretending NNR set it.
 */
const macroLineSchema = z.object({
  targetG: z.number(),
  /** True when this figure came from the profile rather than from NNR. */
  overridden: z.boolean(),
  /** The derived figure, kept even under an override, so the way back is visible. */
  derivedG: z.number(),
  /** Today's grams, or null when no entry carried this macro. */
  todayG: z.number().nullable(),
  /** 0-1 of today's energy that carried it. Absent is not zero (D44). */
  todayCoverage: z.number().min(0).max(1),
  todayComplete: z.boolean(),
  /**
   * The seven-day mean, which is what NNR's values actually refer to, and the
   * only figure compared against `targetG`.
   */
  weeklyMeanG: z.number().nullable(),
  /** How many of the last seven days contributed to that mean. */
  weeklyDays: z.number().int().min(0).max(7),
});
export type MacroLineDto = z.infer<typeof macroLineSchema>;

/**
 * The macro block. Null when there is no plan, because every figure in it is
 * derived from the plan's daily target and there is nothing honest to show
 * without one.
 */
export const macroTargetsSchema = z.object({
  /** Which rule set the protein figure, so the UI can explain it (D52). */
  proteinBasis: z.enum(["energy_percent", "per_kg"]),
  /** True under 8 MJ/day, where NNR raises the protein question. */
  belowLowEnergyThreshold: z.boolean(),
  protein: macroLineSchema,
  carbs: macroLineSchema,
  fat: macroLineSchema,
  fiber: macroLineSchema,
});
export type MacroTargetsDto = z.infer<typeof macroTargetsSchema>;

export const insightsResponseSchema = z.object({
  /** The local date the figures were computed for, from the client's timezone. */
  asOf: z.string(),
  maintenance: maintenanceSchema,
  /** Smoothed weight now, or null with no readings. */
  trendWeightKg: z.number().nullable(),
  /**
   * Today's intake as `calc/intake.ts` resolves it: the manual row if there is
   * one, otherwise the day's food entries, otherwise **null**, which is absent
   * and not zero. Sent from the server so the client cannot hold a second,
   * divergent definition of what a logged day is.
   */
  todayIntakeKcal: z.number().nullable(),
  /** From the active plan, or null when there is no plan. */
  targetIntakeKcal: z.number().nullable(),
  goalWeightKg: z.number().nullable(),
  /**
   * Side by side, never blended (§4.3). Either can be null: "on plan" needs a
   * plan and a maintenance figure, "at current pace" needs actual movement.
   */
  projections: z.object({
    onPlan: projectionSchema.nullable(),
    atCurrentPace: projectionSchema.nullable(),
  }),
  /** Total days with a weight reading. Drives the pre-data copy. */
  readingCount: z.number().int().min(0),
  /**
   * Set when the active plan should be put back in front of the user because
   * maintenance has moved under it (D25). Never applied automatically.
   */
  planReview: planReviewSchema.nullable(),
  /** The instance floor, so the plan form can bound its own field (D24). */
  systemFloorKcal: z.number().int().min(0),
  /** Which exercise-to-target case is in force today, and why (D31). */
  exerciseAdjustment: exerciseAdjustmentSchema,
  /**
   * Smoothed waist-to-height on the same day axis as the trend, or an empty
   * array with no waist history or no height (§4.4). The chart offers its
   * toggle only when this has points.
   */
  whtr: z.array(
    z.object({
      localDate: z.string(),
      raw: z.number().nullable(),
      whtr: z.number(),
      interpolated: z.boolean(),
    }),
  ),
  /** The rule-of-thumb reference line, so the client does not hard-code 0.5. */
  whtrRuleOfThumb: z.number(),
  /**
   * BMI from the **trend** weight, not the latest reading, for the same reason
   * §4.4 smooths waist: a figure that moves with a dehydrated morning invites
   * reading noise as change. Null without a reading or a height.
   */
  bmi: z.number().nullable(),
  /**
   * Macro targets and what has been eaten against them (D52). Null with no
   * active plan, since every figure is derived from its daily target.
   */
  macros: macroTargetsSchema.nullable(),
  /**
   * Today's total energy from the food log, and how complete it is.
   *
   * Separate from `todayIntakeKcal`, which is the resolved figure the whole app
   * agrees on. This is the day card's own accounting: what is left against the
   * target, and whether anything was logged at all.
   */
  todayRemainingKcal: z.number().nullable(),
});
export type InsightsResponse = z.infer<typeof insightsResponseSchema>;

/** `?asOf=` — the client's local date, because the server must not derive one. */
export const insightsQuerySchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional(),
});
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;
