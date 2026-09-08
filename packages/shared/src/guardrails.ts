/**
 * Product guardrails from CLAUDE.md §3.
 *
 * These are enforced server-side, not just in the UI, and they live here so the
 * client can show the same message before the round trip and the server can
 * reject with the identical wording afterwards. Pure functions, no I/O.
 *
 * The messages are in **Swedish**, because the app has exactly one language
 * (D21) and that includes what the API says. Keeping them here rather than in
 * the web dictionary is deliberate: §3 requires the 422 itself to be readable,
 * so a message assembled only in the browser would leave the API answering in
 * codes to anyone reading it directly.
 *
 * Note what is deliberately absent: there is no "eat back" arithmetic anywhere,
 * and a day under target creates no debt that carries forward.
 */

/** Rate of loss above this fraction of bodyweight per week is refused. */
export const MAX_WEEKLY_LOSS_FRACTION = 0.01;

/**
 * The floor beneath the floor.
 *
 * `plans.intake_floor_kcal` is the user's own limit, and a limit the user can
 * lower on a bad evening is advice, not a guardrail. §3 says these are enforced
 * server-side, which has to mean there is a number the user cannot argue with.
 *
 * 1200 kcal is the conventional line below which sustained intake needs medical
 * supervision rather than an app. It is configuration, not a constant, because
 * the one person who might legitimately need it moved is the operator of their
 * own instance — and moving it is then a deliberate act on the server, recorded
 * in `.env`, rather than a slider in a moment of enthusiasm.
 */
export const DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL = 1200;

export type GuardrailViolation = {
  /** Machine-readable, for the client to key on. */
  code:
    | "intake_below_system_floor"
    | "intake_below_floor"
    | "rate_too_fast"
    | "no_weight_reading";
  /** Written for a person, because it is shown to one verbatim. */
  message: string;
  field: "targetIntakeKcal" | "targetRateKgWeek" | "weightKg";
};

export type PlanGuardrailInput = {
  targetIntakeKcal: number;
  /**
   * Whether the user has logged at least one weight. Without it neither
   * guardrail can run: there is no bodyweight to take 1% of, and no maintenance
   * figure to compute a deficit against. Defaults true so the pure checks stay
   * usable on their own; the plan service always passes it.
   */
  hasWeightReading?: boolean;
  /** The user's own floor. May raise the limit, never lower it. */
  intakeFloorKcal: number;
  /** The instance's hard floor. Defaults to {@link DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL}. */
  systemFloorKcal?: number;
  targetRateKgWeek?: number | null;
  /** Current bodyweight, used to turn the 1% rule into an absolute number. */
  referenceWeightKg?: number | null;
};

/**
 * Every violation, not just the first, so the UI can mark both fields at once
 * instead of making the user discover them one submit at a time.
 */
export function checkPlanGuardrails(input: PlanGuardrailInput): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  /**
   * Nothing else can be checked without a weight. A plan saved at this point
   * would be entirely unvalidated — and this is exactly when people set one, in
   * the first minutes of using the app. Refusing is better than accepting
   * something no rule has looked at (D28).
   */
  if (input.hasWeightReading === false) {
    return [
      {
        code: "no_weight_reading",
        field: "weightKg",
        message:
          "Logga en vikt först. Utan den finns det inget att räkna kaloriunderskottet " +
          "mot, och ingen kroppsvikt att mäta 1 %-gränsen mot — planen skulle sparas " +
          "helt okontrollerad.",
      },
    ];
  }

  const systemFloor = input.systemFloorKcal ?? DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL;
  // The user's floor can only ever raise the limit.
  const effectiveFloor = Math.max(systemFloor, input.intakeFloorKcal);

  if (input.targetIntakeKcal < effectiveFloor) {
    // Which limit was hit changes what the user can do about it, so the two
    // cases are distinct codes with distinct messages rather than one generic
    // "below the floor".
    const hitSystemFloor = input.targetIntakeKcal < systemFloor;

    violations.push(
      hitSystemFloor
        ? {
            code: "intake_below_system_floor",
            field: "targetIntakeKcal",
            message:
              `Ett mål på ${Math.round(input.targetIntakeKcal)} kcal ligger under den ` +
              `här serverns hårda gräns på ${Math.round(systemFloor)} kcal. Den går inte ` +
              `att ändra härifrån.`,
          }
        : {
            code: "intake_below_floor",
            field: "targetIntakeKcal",
            message:
              `Ett mål på ${Math.round(input.targetIntakeKcal)} kcal ligger under den ` +
              `gräns på ${Math.round(input.intakeFloorKcal)} kcal du satt själv. Höj målet, ` +
              `eller sänk din gräns — dock aldrig under ${Math.round(systemFloor)} kcal.`,
          },
    );
  }

  const rate = input.targetRateKgWeek;
  const weight = input.referenceWeightKg;
  if (rate != null && weight != null && weight > 0) {
    // `targetRateKgWeek` is kg of loss per week, positive. The magnitude is what
    // gets capped, so a plan entered as -0.7 is treated the same as 0.7 rather
    // than sailing past the check on a sign convention.
    const lossPerWeek = Math.abs(rate);
    const maxPerWeek = weight * MAX_WEEKLY_LOSS_FRACTION;
    // Float tolerance: 0.85 against a 0.85 limit must pass.
    if (lossPerWeek > maxPerWeek + 1e-9) {
      violations.push({
        code: "rate_too_fast",
        field: "targetRateKgWeek",
        message:
          `${lossPerWeek.toFixed(2)} kg i veckan är mer än 1 % av ${weight.toFixed(1)} kg. ` +
          `Det mesta den här planen accepterar är ${maxPerWeek.toFixed(2)} kg i veckan.`,
      });
    }
  }

  return violations;
}

/** One readable sentence for a 422 body, or `null` when the plan is fine. */
export function planGuardrailMessage(input: PlanGuardrailInput): string | null {
  const violations = checkPlanGuardrails(input);
  if (violations.length === 0) return null;
  return violations.map((violation) => violation.message).join(" ");
}

/**
 * Re-checking a plan when maintenance moves — DECISIONS.md D25.
 *
 * The rate guardrail is validated once, at write time, against a figure that is
 * designed to change. A plan checked against a formula estimate, or against no
 * estimate at all, can come to imply a rate the guardrail would have refused.
 */

/**
 * The change in maintenance that counts as material.
 *
 * 10%. §4.2's own standard error is around 4.5% of a 2600 kcal figure (D19), so
 * a smaller threshold would fire on sampling noise. 10% is ~260 kcal, about half
 * a day's deficit — enough to move a goal date by weeks.
 */
export const MATERIAL_TDEE_CHANGE = 0.1;

export type PlanReviewReason = "source_improved" | "tdee_moved";

export type PlanReview = {
  reason: PlanReviewReason;
  /** The maintenance the plan was written against, if it is known. */
  previousTdee: number | null;
  currentTdee: number;
  /** kg per week the plan now implies, from the current figure. */
  impliedRateKgWeek: number;
  /** What the user asked for, if they set one. */
  plannedRateKgWeek: number | null;
  /** Violations the plan would now fail on. Empty when it merely changed. */
  violations: GuardrailViolation[];
};

export type PlanReviewInput = {
  targetIntakeKcal: number;
  intakeFloorKcal: number;
  systemFloorKcal?: number;
  targetRateKgWeek?: number | null;
  referenceWeightKg?: number | null;
  /** The current adaptive or formula figure, and where it came from. */
  currentTdee: number | null;
  currentSource: "adaptive" | "formula" | "none";
  /** What was current when the plan was last written or confirmed. */
  previousTdee?: number | null;
  previousSource?: "adaptive" | "formula" | "none" | null;
};

/** kg per week implied by a daily deficit. Positive means losing. */
export function impliedRateKgWeek(
  tdee: number,
  targetIntakeKcal: number,
  kcalPerKg = 7700,
): number {
  return ((tdee - targetIntakeKcal) * 7) / kcalPerKg;
}

/**
 * Whether the active plan should be put back in front of the user, and why.
 *
 * Returns `null` when nothing has meaningfully changed. Never modifies the
 * plan — the caller surfaces this and the user decides (D25).
 */
export function reviewPlan(input: PlanReviewInput): PlanReview | null {
  const { currentTdee, currentSource, previousTdee = null, previousSource = null } = input;

  // Nothing to re-check against.
  if (currentTdee === null || currentSource === "none") return null;

  const improved =
    currentSource === "adaptive" &&
    (previousSource === null || previousSource === "none" || previousSource === "formula");

  const moved =
    previousTdee !== null &&
    previousTdee > 0 &&
    Math.abs(currentTdee / previousTdee - 1) >= MATERIAL_TDEE_CHANGE;

  if (!improved && !moved) return null;

  return {
    reason: improved ? "source_improved" : "tdee_moved",
    previousTdee,
    currentTdee,
    impliedRateKgWeek: impliedRateKgWeek(currentTdee, input.targetIntakeKcal),
    plannedRateKgWeek: input.targetRateKgWeek ?? null,
    violations: checkPlanGuardrails({
      targetIntakeKcal: input.targetIntakeKcal,
      intakeFloorKcal: input.intakeFloorKcal,
      systemFloorKcal: input.systemFloorKcal,
        targetRateKgWeek: impliedRateKgWeek(currentTdee, input.targetIntakeKcal),
      referenceWeightKg: input.referenceWeightKg,
    }),
  };
}
