import { useState, type FormEvent } from "react";
import type { MacroTargetsDto, MeResponse } from "shared";
import { formatDecimal, updateProfileSchema } from "shared";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "./Field.js";
import { readNumber } from "../lib/form-number.js";
import { useUpdateProfile } from "../lib/session.js";
import { ApiError } from "../lib/api.js";
import { t, type TranslationKey } from "../i18n/index.js";

/**
 * Overriding the NNR-derived macro targets (D52).
 *
 * The targets are **derived, never stored**: they are a function of the plan's
 * daily target and the trend weight, so they move when the plan does. An
 * override is therefore not "a saved target" but an exception to that function,
 * and the shape of this form follows from it.
 *
 * **An empty field means the derived value.** Not a copy of it, and not a
 * separate "use default" switch. A copy would be a second definition that
 * quietly keeps describing last month's plan; a switch would be a second piece
 * of state to keep in step with the field beside it. Clearing the box is the
 * whole way back, and the derived figure is printed under each field so that
 * way back is visible rather than remembered.
 */
const FIELDS = [
  { key: "protein", api: "macroProteinG" },
  { key: "carbs", api: "macroCarbsG" },
  { key: "fat", api: "macroFatG" },
  { key: "fiber", api: "macroFiberG" },
] as const;

type Overrides = MeResponse["profile"]["macroOverrides"];

const OVERRIDE_KEY = {
  protein: "proteinG",
  carbs: "carbsG",
  fat: "fatG",
  fiber: "fiberG",
} as const;

export function MacroTargetForm({
  overrides,
  macros,
}: {
  overrides: Overrides;
  /** The derived figures, or null when there is no plan to derive them from. */
  macros: MacroTargetsDto | null;
}) {
  const update = useUpdateProfile();

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      FIELDS.map(({ key }) => {
        const stored = overrides[OVERRIDE_KEY[key]];
        return [key, stored === null ? "" : formatDecimal(stored, { decimals: 0 })];
      }),
    ),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setSaved(false);

    const payload: Record<string, number | null> = {};

    for (const { key, api } of FIELDS) {
      const raw = values[key] ?? "";
      if (raw.trim() === "") {
        // Explicitly null, which clears the override on the server.
        payload[api] = null;
        continue;
      }

      const parsed = readNumber(raw, { required: true });
      if (!parsed.ok) {
        setErrors({ [key]: parsed.message });
        return;
      }
      payload[api] = Math.round(parsed.value!);
    }

    const checked = updateProfileSchema.safeParse(payload);
    if (!checked.success) {
      setErrors(fieldErrorsFrom(checked.error.issues));
      return;
    }

    update.mutate(checked.data, { onSuccess: () => setSaved(true) });
  }

  const submitError =
    update.error instanceof ApiError
      ? update.error.message
      : update.error
        ? t("auth.unreachable")
        : null;

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="max-w-prose text-note text-muted">{t("macro.ownTargetsNote")}</p>

      {macros === null ? (
        <p className="max-w-prose text-note text-muted">{t("macro.noPlanYet")}</p>
      ) : null}

      {FIELDS.map(({ key }) => (
        <Field
          key={key}
          id={`macro-${key}`}
          label={t(`macro.${key}` as TranslationKey)}
          error={errors[key]}
          hint={
            macros
              ? t("macro.derivedIs", {
                  amount: formatDecimal(macros[key].derivedG, { decimals: 0 }),
                })
              : undefined
          }
        >
          <input
            id={`macro-${key}`}
            className="field num"
            type="text"
            inputMode="numeric"
            data-testid={`macro-${key}`}
            placeholder={
              macros ? formatDecimal(macros[key].derivedG, { decimals: 0 }) : undefined
            }
            value={values[key] ?? ""}
            onChange={(event) =>
              setValues((current) => ({ ...current, [key]: event.target.value }))
            }
            {...fieldAria(`macro-${key}`, errors[key], true)}
          />
        </Field>
      ))}

      {submitError ? (
        <p role="alert" className="text-note text-muted">
          {submitError}
        </p>
      ) : null}

      <button className="btn-secondary" type="submit" disabled={update.isPending}>
        {update.isPending
          ? t("profile.saving")
          : saved
            ? t("profile.saved")
            : t("macro.saveTargets")}
      </button>
    </form>
  );
}
