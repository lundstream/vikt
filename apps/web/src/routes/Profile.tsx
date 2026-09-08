import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL,
  formatForInput,
  updateProfileSchema,
} from "shared";
import { ApiError } from "../lib/api.js";
import { useMe, useUpdateProfile } from "../lib/session.js";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "../components/Field.js";
import { PlanForm } from "../components/PlanForm.js";
import { MacroTargetForm } from "../components/MacroTargetForm.js";
import { t } from "../i18n/index.js";
import { readNumber } from "../lib/form-number.js";
import { useActivePlan } from "../lib/plan.js";
import { useInsights, useWeightLog } from "../lib/log.js";
import { todayLocalDate } from "../lib/dates.js";

/**
 * Profile.
 *
 * Reached from the dashboard when maintenance comes back as `"none"` and names
 * the fields it is missing (D20). The framing matters: these are optional, and
 * the copy says so, because someone who logs consistently gets a better number
 * from their own data than the formula would ever give them.
 */
export function Profile() {
  const me = useMe();
  const update = useUpdateProfile();
  const plan = useActivePlan();
  const weightLog = useWeightLog();


  const profile = me.data?.profile;
  const insights = useInsights(todayLocalDate(profile?.timezone ?? "Europe/Stockholm"));
  const [sex, setSex] = useState<string>(profile?.sex ?? "unspecified");
  const [birthDate, setBirthDate] = useState(profile?.birthDate ?? "");
  const [heightCm, setHeightCm] = useState(formatForInput(profile?.heightCm));
  const [lastDrinkOn, setLastDrinkOn] = useState(profile?.lastDrinkOn ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  if (me.isPending) return null;
  if (!me.data) return <Navigate to="/login" replace />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setSaved(false);

    const height = readNumber(heightCm);
    if (!height.ok) {
      setErrors({ heightCm: height.message });
      return;
    }

    const parsed = updateProfileSchema.safeParse({
      sex,
      birthDate: birthDate === "" ? null : birthDate,
      heightCm: height.value ?? undefined,
    });

    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    update.mutate(parsed.data, { onSuccess: () => setSaved(true) });
  }

  const exercise = insights.data?.exerciseAdjustment;

  const submitError =
    update.error instanceof ApiError
      ? update.error.message
      : update.error
        ? t("auth.unreachable")
        : null;

  return (
    <main className="mx-auto w-full max-w-sm px-5 py-10">
      <header className="mb-6">
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("profile.back")}
        </Link>
        <h1 className="mt-4 text-title text-ink">{t("profile.title")}</h1>
        <p className="mt-2 max-w-prose text-note text-muted">
          {t("profile.intro")}
        </p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field
          id="sex"
          label={t("profile.sex")}
          error={errors.sex}
          hint={t("profile.sexHint")}
        >
          <select
            id="sex"
            className="select"
            {...fieldAria("sex", errors.sex, true)}
            value={sex}
            onChange={(e) => setSex(e.target.value)}
          >
            <option value="unspecified">{t("profile.sexUnspecified")}</option>
            <option value="female">{t("profile.sexFemale")}</option>
            <option value="male">{t("profile.sexMale")}</option>
          </select>
        </Field>

        <Field
          id="birthDate"
          label={t("profile.birthDate")}
          error={errors.birthDate}
          hint={t("profile.birthDateHint")}
        >
          <input
            id="birthDate"
            className="field num"
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            {...fieldAria("birthDate", errors.birthDate, true)}
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
          />
        </Field>

        <Field id="heightCm" label={t("auth.height")} error={errors.heightCm}>
          <input
            id="heightCm"
            className="field num"
            type="text"
            inputMode="decimal"
            {...fieldAria("heightCm", errors.heightCm)}
            value={heightCm}
            onChange={(e) => setHeightCm(e.target.value)}
          />
        </Field>

        {submitError ? (
          <p role="alert" className="text-note text-muted">
            {submitError}
          </p>
        ) : null}

        <button className="btn" type="submit" disabled={update.isPending}>
          {update.isPending ? t("profile.saving") : saved ? t("profile.saved") : t("profile.save")}
        </button>
      </form>

      {/*
        D44. A run that started before the app did.

        The counter can only be built from `daily_log` rows, so someone eighty
        days sober when they install this has nothing to build it from. Asking
        them to backfill eighty days to see a number they already know is how a
        feature goes unused. One date replaces all of it, and a logged drink
        after that date wins.
      */}
      <section className="mt-12 border-t border-edge pt-8">
        <h2 className="text-title font-semibold text-ink">
          {t("profile.soberTitle")}
        </h2>

        <div className="mt-4">
          <Field
            id="lastDrinkOn"
            label={t("profile.lastDrinkOn")}
            hint={t("profile.lastDrinkHint")}
          >
            <input
              id="lastDrinkOn"
              className="field num"
              type="date"
              data-testid="last-drink-on"
              max={new Date().toISOString().slice(0, 10)}
              {...fieldAria("lastDrinkOn", undefined, true)}
              value={lastDrinkOn}
              onChange={(event) => {
                setLastDrinkOn(event.target.value);
                update.mutate({
                  lastDrinkOn: event.target.value === "" ? null : event.target.value,
                });
              }}
            />
          </Field>
        </div>

        {/*
          D35, stated rather than implied. The two readings of an unlogged day
          give different numbers, so which one is running has to be visible.
        */}
        <p className="mt-5 text-note font-medium text-muted">{t("profile.soberRuleTitle")}</p>
        <label className="mt-2 flex items-start gap-3 text-note">
          <input
            type="checkbox"
            data-testid="sober-assume-dry"
            className="check mt-0.5"
            checked={profile?.soberAssumeUnloggedDry ?? false}
            disabled={update.isPending}
            onChange={(event) =>
              update.mutate({ soberAssumeUnloggedDry: event.target.checked })
            }
          />
          <span className="text-ink">{t("profile.soberRuleToggle")}</span>
        </label>
        <p className="mt-2 max-w-prose text-micro text-muted">
          {profile?.soberAssumeUnloggedDry
            ? t("profile.soberRuleAssume")
            : t("profile.soberRuleStrict")}
        </p>
      </section>

      {/*
        D31. When maintenance is adaptive the switch is **disabled**, not merely
        off, and the paragraph above it says why — an adaptive figure is derived
        from what the trend line actually did against what was actually eaten,
        so the training is already inside it. The API refuses the change too
        (`422 adaptive_includes_activity`); this is the half that stops anyone
        having to find that out by trying.
      */}
      <section className="mt-12 border-t border-edge pt-8">
        <h2 className="text-title font-semibold text-ink">
          {t("profile.exerciseTitle")}
        </h2>
        <p className="mb-4 mt-2 max-w-prose text-note text-muted">
          {exercise?.reason === "adaptive_includes_activity"
            ? t("profile.exerciseAdaptive")
            : exercise?.reason === "no_maintenance_figure"
              ? t("profile.exerciseNoFigure")
              : t("profile.exerciseFormula")}
        </p>

        <label className="flex items-start gap-3 text-note">
          <input
            type="checkbox"
            data-testid="add-exercise-to-target"
            className="check mt-0.5"
            checked={exercise?.inForce ?? false}
            disabled={!exercise?.available || update.isPending}
            onChange={(event) =>
              update.mutate(
                { addExerciseToTarget: event.target.checked },
                { onSuccess: () => setSaved(true) },
              )
            }
          />
          <span className={exercise?.available ? "text-ink" : "text-muted"}>
            {t("profile.exerciseToggle")}
          </span>
        </label>

        {exercise && !exercise.available && exercise.preference ? (
          <p className="mt-2 text-micro text-muted">{t("profile.exercisePreferenceKept")}</p>
        ) : null}
      </section>

      <section className="mt-12 border-t border-edge pt-8">
        <h2 className="text-title font-semibold text-ink">{t("plan.title")}</h2>
        <p className="mb-4 mt-2 max-w-prose text-note text-muted">
          {t("plan.intro")}
        </p>
        <PlanForm
          plan={plan.data ?? null}
          timezone={profile?.timezone ?? "Europe/Stockholm"}
          currentWeightKg={weightLog.data?.at(-1)?.weightKg ?? null}
          systemFloorKcal={insights.data?.systemFloorKcal ?? DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL}
        />
      </section>

      {/*
        Macro targets, overridable (D52). After the plan, because every derived
        figure comes out of the plan's daily target: setting the plan is what
        produces the defaults this form is an exception to.
      */}
      {profile ? (
        <section className="mt-12 border-t border-edge pt-8">
          <h2 className="text-title font-semibold text-ink">{t("macro.ownTargets")}</h2>
          <div className="mt-4">
            <MacroTargetForm
              overrides={profile.macroOverrides}
              macros={insights.data?.macros ?? null}
            />
          </div>
        </section>
      ) : null}
    </main>
  );
}
