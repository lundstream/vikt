import { useEffect, useState, type FormEvent } from "react";
import { createPlanSchema, formatForInput, type Plan } from "shared";
import { ApiError } from "../lib/api.js";
import { useSavePlan } from "../lib/plan.js";
import { todayLocalDate } from "../lib/dates.js";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "./Field.js";
import { t } from "../i18n/index.js";
import { readNumber, readRequiredNumber } from "../lib/form-number.js";

/**
 * The plan: a goal weight, a daily target, and the floor the target is checked
 * against.
 *
 * The server enforces the §3 guardrails and answers 422 with a sentence written
 * for a person, so this form shows that sentence rather than inventing its own
 * wording. Duplicating the rule in the client would mean two places to keep in
 * step, and the client's copy would be the one that quietly drifted.
 */
export function PlanForm({
  plan,
  timezone,
  currentWeightKg,
  systemFloorKcal,
}: {
  plan: Plan | null;
  timezone: string;
  currentWeightKg: number | null;
  /** The instance floor. The user's own field may only raise it (D24). */
  systemFloorKcal: number;
}) {
  const save = useSavePlan();
  const today = todayLocalDate(timezone);

  const [goalWeightKg, setGoalWeightKg] = useState("");
  const [targetIntakeKcal, setTargetIntakeKcal] = useState("");
  const [intakeFloorKcal, setIntakeFloorKcal] = useState(String(systemFloorKcal));
  const [targetRateKgWeek, setTargetRateKgWeek] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!plan) return;
    setGoalWeightKg(formatForInput(plan.goalWeightKg));
    setTargetIntakeKcal(formatForInput(plan.targetIntakeKcal, 0));
    setIntakeFloorKcal(formatForInput(plan.intakeFloorKcal, 0));
    setTargetRateKgWeek(formatForInput(plan.targetRateKgWeek, 2));
  }, [plan]);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setSaved(false);

    // Every field is parsed locale-aware: a Swedish keypad types "0,5".
    const fields = {
      goalWeightKg: readNumber(goalWeightKg),
      targetIntakeKcal: readRequiredNumber(targetIntakeKcal),
      intakeFloorKcal: readRequiredNumber(intakeFloorKcal),
      targetRateKgWeek: readNumber(targetRateKgWeek),
    } as const;

    const unparseable: FieldErrors = {};
    for (const [field, result] of Object.entries(fields)) {
      if (!result.ok) unparseable[field] = result.message;
    }
    if (Object.keys(unparseable).length > 0) {
      setErrors(unparseable);
      return;
    }

    const parsed = createPlanSchema.safeParse({
      name: plan?.name ?? "My plan",
      startDate: plan?.startDate ?? today,
      goalWeightKg: fields.goalWeightKg.ok ? fields.goalWeightKg.value : null,
      targetIntakeKcal: fields.targetIntakeKcal.ok ? fields.targetIntakeKcal.value : Number.NaN,
      intakeFloorKcal: fields.intakeFloorKcal.ok ? fields.intakeFloorKcal.value : Number.NaN,
      targetRateKgWeek: fields.targetRateKgWeek.ok ? fields.targetRateKgWeek.value : null,
      startWeightKg: plan?.startWeightKg ?? currentWeightKg ?? null,
    });

    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    save.mutate(
      { planId: plan?.id ?? null, input: parsed.data },
      { onSuccess: () => setSaved(true) },
    );
  }

  // The guardrail rejection, verbatim from the server.
  const guardrail =
    save.error instanceof ApiError && save.error.status === 422 ? save.error.message : null;
  const otherError =
    save.error && !guardrail
      ? save.error instanceof ApiError
        ? save.error.message
        : t("auth.unreachable")
      : null;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <Field
        id="goalWeight"
        label={t("plan.goalWeight")}
        error={errors.goalWeightKg}
        hint={t("plan.goalWeightHint")}
      >
        <input
          id="goalWeight"
          className="field num"
          type="text"
          inputMode="decimal"
          {...fieldAria("goalWeight", errors.goalWeightKg, true)}
          value={goalWeightKg}
          onChange={(e) => setGoalWeightKg(e.target.value)}
        />
      </Field>

      <Field id="targetIntake" label={t("plan.targetIntake")} error={errors.targetIntakeKcal}>
        <input
          id="targetIntake"
          className="field num"
          type="text"
          inputMode="numeric"
          required
          {...fieldAria("targetIntake", errors.targetIntakeKcal)}
          value={targetIntakeKcal}
          onChange={(e) => setTargetIntakeKcal(e.target.value)}
        />
      </Field>

      <Field
        id="intakeFloor"
        label={t("plan.floor")}
        error={errors.intakeFloorKcal}
        hint={t("plan.floorHint", { system: systemFloorKcal })}
      >
        <input
          id="intakeFloor"
          className="field num"
          type="text"
          inputMode="numeric"
          required
          {...fieldAria("intakeFloor", errors.intakeFloorKcal, true)}
          value={intakeFloorKcal}
          onChange={(e) => setIntakeFloorKcal(e.target.value)}
        />
      </Field>

      <Field
        id="targetRate"
        label={t("plan.rate")}
        error={errors.targetRateKgWeek}
        hint={t("plan.rateHint")}
      >
        <input
          id="targetRate"
          className="field num"
          type="text"
          inputMode="decimal"
          {...fieldAria("targetRate", errors.targetRateKgWeek, true)}
          value={targetRateKgWeek}
          onChange={(e) => setTargetRateKgWeek(e.target.value)}
        />
      </Field>

      {guardrail ? (
        <p role="alert" className="max-w-prose text-note text-ink">
          {guardrail}
        </p>
      ) : null}
      {otherError ? (
        <p role="alert" className="text-note text-muted">
          {otherError}
        </p>
      ) : null}

      <button className="btn" type="submit" disabled={save.isPending}>
        {save.isPending
          ? t("profile.saving")
          : saved
            ? t("profile.saved")
            : plan
              ? t("plan.update")
              : t("plan.create")}
      </button>
    </form>
  );
}
