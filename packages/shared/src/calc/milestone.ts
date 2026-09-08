/**
 * Milestone detection.
 *
 * Two rules govern everything here.
 *
 * **Detection runs on the trend value, never the raw reading.** A single
 * dehydrated morning can put the scale two kilos under where the body actually
 * is, and a milestone that fires on it is a milestone that fires on nothing.
 * The trend is the number this product is about (D2), so it is the number that
 * counts.
 *
 * **Achievement is permanent.** `achievedAt` is set once and never cleared, and
 * nothing recomputes it from the current value. A trend that rises again does
 * not un-reach 99 kg: it happened, and taking it back would be both false and
 * the exact "you ruined it" failure state §3 forbids. It is a timestamp column
 * that nothing cascades to, per §3 and D17, not a nullable foreign key and not
 * something inferred from the current series.
 *
 * Pure. No I/O, no clock.
 */

export type MilestoneMetric =
  | "weight_kg"
  | "waist_cm"
  | "chest_cm"
  | "whtr"
  | "log_streak_days"
  | "sober_days";

/**
 * Which way a metric has to move to reach a target.
 *
 * Not inferred from the current value, which would make the same milestone mean
 * opposite things depending on when it was created: "waist 90" set at 95 would
 * be a target to get under, and set at 85 a target to grow into. Every metric
 * here has one obvious direction, so it is stated.
 */
export const METRIC_DIRECTION: Record<MilestoneMetric, "down" | "up"> = {
  weight_kg: "down",
  waist_cm: "down",
  chest_cm: "down",
  whtr: "down",
  log_streak_days: "up",
  sober_days: "up",
};

/**
 * What a milestone target is measured in, and what counts as a plausible one.
 *
 * A target field with no unit is a field you can get wrong in silence: 95 is a
 * reasonable waist in centimetres, a reasonable weight in kilos and a nonsense
 * ratio, and the form used to accept all three without saying which it wanted.
 * The metric is already chosen in the select beside it, so the unit is derivable
 * and there is no reason to make the user carry it.
 *
 * The bands refuse typos, not opinions. They are wide on purpose: this is the
 * slipped-decimal-point check, not a judgement about what anyone should weigh.
 * `waist_cm` and `chest_cm` reuse `MEASUREMENT_RANGE_CM` so a milestone cannot
 * be set to a figure the measurement form would itself refuse.
 *
 * `whtr` has no unit at all, which is a fact about the ratio rather than a
 * missing string: printing "kg" beside 0,48 would be worse than printing
 * nothing. The suffix is empty and `decimals` says how precisely to read it.
 */
export type MetricUnit = {
  /** Shown as a suffix in the field. Empty for a plain ratio. */
  suffix: string;
  min: number;
  max: number;
  /** How many decimals the target is meaningful to. */
  decimals: number;
};

export const METRIC_UNIT: Record<MilestoneMetric, MetricUnit> = {
  weight_kg: { suffix: "kg", min: 30, max: 400, decimals: 1 },
  waist_cm: { suffix: "cm", min: 40, max: 250, decimals: 1 },
  chest_cm: { suffix: "cm", min: 40, max: 250, decimals: 1 },
  // A ratio, so no suffix. 0.2 and 1.5 are both anatomically impossible and
  // both are what a mistyped 20 or 150 would land on.
  whtr: { suffix: "", min: 0.2, max: 1.5, decimals: 2 },
  log_streak_days: { suffix: "dagar", min: 1, max: 3650, decimals: 0 },
  sober_days: { suffix: "dagar", min: 1, max: 3650, decimals: 0 },
};

/**
 * Whether a target is inside its metric's band.
 *
 * Returns the band rather than a boolean when it fails, so the caller can say
 * *what* was expected instead of "invalid". A message that names the range is
 * the difference between fixing a typo and guessing at one.
 */
export function checkMilestoneTarget(
  metric: MilestoneMetric,
  targetValue: number,
): { ok: true } | { ok: false; unit: MetricUnit } {
  const unit = METRIC_UNIT[metric];
  if (!Number.isFinite(targetValue)) return { ok: false, unit };
  return targetValue >= unit.min && targetValue <= unit.max
    ? { ok: true }
    : { ok: false, unit };
}

export type MilestoneInput = {
  id: string;
  metric: MilestoneMetric;
  targetValue: number;
  achievedAt: string | null;
};

/** Whether `value` has reached `target` for this metric. */
export function hasReached(
  metric: MilestoneMetric,
  value: number,
  targetValue: number,
): boolean {
  return METRIC_DIRECTION[metric] === "down" ? value <= targetValue : value >= targetValue;
}

/**
 * How close the metric is, as a fraction of the way from `startValue` to the
 * target. Clamped to 0..1; null when there is no usable starting point.
 */
export function progressToward(input: {
  metric: MilestoneMetric;
  currentValue: number | null;
  targetValue: number;
  startValue: number | null;
}): number | null {
  const { currentValue, targetValue, startValue } = input;
  if (currentValue === null || startValue === null) return null;

  const span = targetValue - startValue;
  if (Math.abs(span) < 1e-9) return currentValue === targetValue ? 1 : null;

  const done = (currentValue - startValue) / span;
  return Math.min(1, Math.max(0, done));
}

/* ------------------------------------------------------- the "close" state */

/**
 * How near the **raw** series has to come before a milestone is called close.
 *
 * The problem this solves (D36): the time-aware EMA lags a steadily changing
 * series by about nine days at daily cadence, so the scale reads 99.4 for a week
 * and a half before the trend crosses 100 and the milestone fires. That lag is
 * correct and is the entire point of smoothing, but *silent* lag reads as the
 * app being broken, and someone who sees the number they were chasing and gets
 * nothing back concludes the feature does not work.
 *
 * So the raw series drives a visible "close to this one" state, while the
 * milestone itself still waits for the trend, and the copy says why it waits.
 * The threshold is a fraction of the metric's own scale rather than an absolute,
 * because 0.5 kg and 0.5 cm and 0.005 on a ratio are not comparable distances.
 */
export const CLOSE_FRACTION = 0.01;

/** Absolute floors, so a large target does not make "close" absurdly wide. */
export const CLOSE_CAP: Record<MilestoneMetric, number> = {
  weight_kg: 1.5,
  waist_cm: 2,
  chest_cm: 2,
  whtr: 0.01,
  log_streak_days: 3,
  sober_days: 3,
};

export function closeThreshold(metric: MilestoneMetric, targetValue: number): number {
  return Math.min(Math.abs(targetValue) * CLOSE_FRACTION, CLOSE_CAP[metric]);
}

export type MilestoneStatus =
  | { state: "achieved"; achievedAt: string }
  /** The raw series has reached it but the smoothed one has not yet. */
  | { state: "raw_reached"; rawValue: number; trendValue: number; remaining: number }
  | { state: "close"; remaining: number }
  | { state: "open"; remaining: number | null };

/**
 * Where a milestone stands today.
 *
 * `raw_reached` is the interesting case and is deliberately distinct from
 * `close`: it means the scale has already shown the number, which is exactly
 * when someone will go looking for the celebration, and the UI can say "the
 * scale has been there, the smoothed line follows in a few days" rather than
 * leaving them to wonder.
 */
export function milestoneStatus(input: {
  metric: MilestoneMetric;
  targetValue: number;
  achievedAt: string | null;
  /** The smoothed value. This is what achievement is judged on. */
  trendValue: number | null;
  /** The most recent raw reading, used only for the "close" states. */
  rawValue: number | null;
}): MilestoneStatus {
  const { metric, targetValue, achievedAt, trendValue, rawValue } = input;

  if (achievedAt !== null) return { state: "achieved", achievedAt };

  const remaining =
    trendValue === null
      ? null
      : METRIC_DIRECTION[metric] === "down"
        ? trendValue - targetValue
        : targetValue - trendValue;

  if (rawValue !== null && hasReached(metric, rawValue, targetValue)) {
    return {
      state: "raw_reached",
      rawValue,
      trendValue: trendValue ?? rawValue,
      remaining: remaining ?? 0,
    };
  }

  if (remaining !== null && remaining > 0 && remaining <= closeThreshold(metric, targetValue)) {
    return { state: "close", remaining };
  }

  return { state: "open", remaining };
}

/**
 * Milestones newly reached by `trendValue`, for the write path.
 *
 * Returns the ones to stamp rather than stamping anything, so the caller owns
 * the transaction. Already-achieved milestones are never returned: achievement
 * is permanent and re-stamping would move `achievedAt` forward and, worse,
 * re-fire the celebration.
 */
export function newlyReached(
  milestones: readonly MilestoneInput[],
  metric: MilestoneMetric,
  trendValue: number,
): MilestoneInput[] {
  return milestones.filter(
    (milestone) =>
      milestone.metric === metric &&
      milestone.achievedAt === null &&
      hasReached(metric, trendValue, milestone.targetValue),
  );
}
