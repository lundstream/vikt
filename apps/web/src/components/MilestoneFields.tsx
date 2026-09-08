import type { ReactNode } from "react";
import { METRIC_UNIT, type MilestoneMetric } from "shared";
import { Field, fieldAria, type FieldErrors } from "./Field.js";
import { t, type TranslationKey } from "../i18n/index.js";

/**
 * The four fields a milestone is made of, shared by the create form and the
 * row editor.
 *
 * One component rather than two copies, because the target field carries logic
 * now — a unit derived from the metric and a plausible band to validate against
 * — and a second copy is a second place for that to drift.
 *
 * **The target field shows its unit.** It did not, and the metric select sits
 * directly beside it, so the unit was derivable the whole time and the user was
 * carrying it instead. 95 is a reasonable waist in centimetres, a reasonable
 * weight in kilos and a nonsense waist-to-height ratio; a field that takes all
 * three without saying which it wants is a field you get wrong in silence.
 *
 * Waist-to-height gets **no suffix**, which is a fact about the ratio rather
 * than a missing string. Printing "kg" beside 0,48 would be worse than nothing.
 */
export const MILESTONE_METRICS: MilestoneMetric[] = [
  "weight_kg",
  "waist_cm",
  "chest_cm",
  "whtr",
  "log_streak_days",
  "sober_days",
];

export function MilestoneFields({
  idPrefix,
  label,
  metric,
  targetValue,
  rewardText,
  rewardCostSek,
  errors,
  onChange,
  children,
}: {
  /** Unique per form instance, so two editors on one page do not share ids. */
  idPrefix: string;
  label: string;
  metric: string;
  targetValue: string;
  rewardText: string;
  rewardCostSek: string;
  errors: FieldErrors;
  onChange: (patch: {
    label?: string;
    metric?: string;
    targetValue?: string;
    rewardText?: string;
    rewardCostSek?: string;
  }) => void;
  /** The submit row, so each caller keeps its own buttons. */
  children?: ReactNode;
}) {
  const unit = METRIC_UNIT[metric as MilestoneMetric] ?? METRIC_UNIT.weight_kg;
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field id={id("label")} label={t("progress.label")} error={errors.label}>
          <input
            id={id("label")}
            className="field"
            value={label}
            onChange={(event) => onChange({ label: event.target.value })}
            {...fieldAria(id("label"), errors.label)}
          />
        </Field>

        <Field id={id("metric")} label={t("progress.metric")}>
          <select
            id={id("metric")}
            className="select"
            value={metric}
            onChange={(event) => onChange({ metric: event.target.value })}
          >
            {MILESTONE_METRICS.map((name) => (
              <option key={name} value={name}>
                {t(`metric.${name}` as TranslationKey)}
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={id("target")}
          label={t("progress.target")}
          error={errors.targetValue}
          hint={t("progress.targetRange", {
            min: band(unit.min),
            max: band(unit.max),
          })}
        >
          {/*
            The suffix sits inside the field rather than in the label, so it
            stays beside the digits as they are typed. `pointer-events-none`
            because it is a label, not a control: tapping it must focus the
            input underneath, which is where a thumb lands on a phone.
          */}
          <div className="relative">
            <input
              id={id("target")}
              className={`field num ${unit.suffix === "" ? "" : "pr-14"}`}
              type="text"
              inputMode={unit.decimals === 0 ? "numeric" : "decimal"}
              value={targetValue}
              onChange={(event) => onChange({ targetValue: event.target.value })}
              {...fieldAria(id("target"), errors.targetValue, true)}
            />
            {unit.suffix === "" ? null : (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-note text-muted"
              >
                {unit.suffix}
              </span>
            )}
          </div>
        </Field>

        <Field
          id={id("cost")}
          label={t("progress.rewardCost")}
          error={errors.rewardCostSek}
        >
          <div className="relative">
            <input
              id={id("cost")}
              className="field num pr-10"
              type="text"
              inputMode="decimal"
              value={rewardCostSek}
              onChange={(event) => onChange({ rewardCostSek: event.target.value })}
              {...fieldAria(id("cost"), errors.rewardCostSek)}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-note text-muted"
            >
              kr
            </span>
          </div>
        </Field>
      </div>

      <div className="mt-3">
        <Field id={id("reward")} label={t("progress.reward")} error={errors.rewardText}>
          <input
            id={id("reward")}
            className="field"
            value={rewardText}
            onChange={(event) => onChange({ rewardText: event.target.value })}
            {...fieldAria(id("reward"), errors.rewardText)}
          />
        </Field>
      </div>

      {errors.form ? (
        <p role="alert" className="mt-2 text-note text-ink">
          {errors.form}
        </p>
      ) : null}

      {children}
    </>
  );
}

/** Swedish decimal comma, and no trailing ",0" on a whole number. */
export const band = (value: number) => String(value).replace(".", ",");
