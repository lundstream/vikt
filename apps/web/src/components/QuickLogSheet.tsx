import { useEffect, useRef, useState, type FormEvent } from "react";
import { createWeightEntrySchema, formatForInput } from "shared";
import { ApiError } from "../lib/api.js";
import {
  useDeleteManualIntake,
  useManualIntakeLog,
  useSaveManualIntake,
  useSaveWeight,
} from "../lib/log.js";
import { describeDay } from "../lib/dates.js";
import { clientUuid } from "../lib/uuid.js";
import { readNumber, readRequiredNumber } from "../lib/form-number.js";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "./Field.js";
import { DeleteButton } from "./DeleteButton.js";
import { LOCALE, t } from "../i18n/index.js";

/**
 * Quick entry. One tap from the dashboard, and the whole point is speed:
 *
 *  - opens with today already selected;
 *  - the weight field is focused and selected on open, so the numeric keypad is
 *    up and typing replaces the suggestion without a tap;
 *  - pre-filled with the most recent reading, because tomorrow's weight is
 *    almost always within a few hundred grams of today's — a nudge is faster
 *    than typing three digits;
 *  - `inputMode="decimal"` so phones show the number pad, not the QWERTY one;
 *  - one primary action, full width, at the bottom where a thumb is.
 *
 * Target: under five seconds from opening the app. That budget is what rules
 * out a date picker, a unit selector, and a confirmation step.
 *
 * Intake is optional and secondary, sitting below the fold of the sheet. It is
 * here rather than on its own screen because the two get logged at the same
 * moment, and phase 2's TDEE needs the intake series to exist.
 */

export type QuickLogSheetProps = {
  open: boolean;
  /** The user's IANA zone, for the day an entry is filed under. */
  timezone: string;
  onClose: () => void;
  today: string;
  /** Seeds the weight field. The last reading, if there is one. */
  lastWeightKg: number | null;
  /** Intake already logged for `today`, if any. */
  todayIntakeKcal: number | null;
};

export function QuickLogSheet({
  open,
  timezone,
  onClose,
  today,
  lastWeightKg,
  todayIntakeKcal,
}: QuickLogSheetProps) {
  // The zone matters: it decides which day an entry belongs to (D39), and the
  // queue stamps that at creation rather than at send time.
  const saveWeight = useSaveWeight(timezone);
  const saveIntake = useSaveManualIntake(timezone);
  const deleteIntake = useDeleteManualIntake();
  const manualLog = useManualIntakeLog();

  const [weightKg, setWeightKg] = useState("");
  const [kcal, setKcal] = useState("");
  const [localDate, setLocalDate] = useState(today);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  /**
   * The manual row for the day being edited, if there is one.
   *
   * Declared after `localDate` rather than beside the other hooks: it reads
   * that state, and `const` in a temporal dead zone is a blank screen rather
   * than a type error.
   *
   * `todayIntakeKcal` cannot stand in for this. It is the *resolved* figure
   * (D44) and does not distinguish a manual total from a sum of meals, and only
   * the manual one exists to be deleted.
   */
  const manualRow = manualLog.data?.find((entry) => entry.localDate === localDate) ?? null;

  const weightInput = useRef<HTMLInputElement>(null);
  const wasOpen = useRef(false);

  /**
   * Reset and focus on the closed -> open transition only. Reacting to the
   * seed values as well would wipe what the user is typing whenever a
   * background refetch lands.
   */
  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;

    setWeightKg(formatForInput(lastWeightKg));
    setKcal(formatForInput(todayIntakeKcal, 0));
    setLocalDate(today);
    setErrors({});
    setSaved(false);
    saveWeight.reset();
    saveIntake.reset();

    // A frame's delay: focusing before the sheet is laid out loses the keypad
    // on some Android browsers.
    const raf = requestAnimationFrame(() => {
      weightInput.current?.focus();
      weightInput.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, today, lastWeightKg, todayIntakeKcal, saveWeight, saveIntake]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    // A Swedish keypad types "87,4"; Number() would make that NaN.
    const weight = readRequiredNumber(weightKg);
    if (!weight.ok) {
      setErrors({ weightKg: weight.message });
      return;
    }

    const parsed = createWeightEntrySchema.safeParse({
      clientUuid: clientUuid(),
      localDate,
      weightKg: weight.value,
    });

    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    const calories = readNumber(kcal);
    if (!calories.ok) {
      setErrors({ kcal: calories.message });
      return;
    }
    const kcalValue = calories.value;
    if (kcalValue !== null && kcalValue < 0) {
      setErrors({ kcal: t("quick.caloriesInvalid") });
      return;
    }

    try {
      await saveWeight.mutateAsync(parsed.data);
      if (kcalValue !== null) {
        await saveIntake.mutateAsync({
          clientUuid: clientUuid(),
          localDate,
          kcal: Math.round(kcalValue),
        });
      }
      setSaved(true);
      // Long enough to register that it worked, short enough not to be a step.
      setTimeout(onClose, 450);
    } catch {
      // Rendered from the mutation's own error state below.
    }
  }

  const submitError =
    saveWeight.error instanceof ApiError
      ? saveWeight.error.message
      : saveIntake.error instanceof ApiError
        ? saveIntake.error.message
        : saveWeight.error || saveIntake.error
          ? t("quick.unreachable")
          : null;

  const pending = saveWeight.isPending || saveIntake.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-ink/40"
        aria-label="Close"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="quicklog-title"
        className="relative w-full max-w-sm rounded-t-2xl border-t border-edge bg-paper
                   px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5
                   sm:rounded-2xl sm:border"
      >
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 id="quicklog-title" className="text-lg font-semibold text-ink">
            {t("quick.title")}
          </h2>
          <button
            type="button"
            className="text-note text-muted underline underline-offset-4"
            onClick={onClose}
          >
            {t("quick.cancel")}
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field id="quick-weight" label={t("quick.weight")} error={errors.weightKg}>
            <input
              ref={weightInput}
              id="quick-weight"
              className="field num text-3xl"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              required
              {...fieldAria("quick-weight", errors.weightKg)}
              value={weightKg}
              onChange={(e) => setWeightKg(e.target.value)}
            />
          </Field>

          <Field
            id="quick-kcal"
            label={t("quick.calories")}
            error={errors.kcal}
            hint={t("quick.caloriesHint")}
          >
            <input
              id="quick-kcal"
              className="field num"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              {...fieldAria("quick-kcal", errors.kcal, true)}
              value={kcal}
              onChange={(e) => setKcal(e.target.value)}
            />

            {/*
              §3: every user-created row gets a delete, on the screen that shows
              it. A manual figure **owns its day** (D44), so while it exists the
              meals logged afterwards are not what the app counts. Overwriting
              it with another guess was the only way out, which is not a delete.

              Shown only when there is a manual row for this day, because on a
              food-logged day there is nothing here to remove.
            */}
            {manualRow ? (
              <div className="mt-2">
                <DeleteButton
                  testId="delete-manual-intake"
                  label={t("quick.clearCaloriesLabel")}
                  onDelete={() => deleteIntake.mutateAsync(manualRow.id)}
                />
                <p className="mt-1 text-micro text-muted">{t("quick.clearCaloriesNote")}</p>
              </div>
            ) : null}
          </Field>

          <Field id="quick-date" label={t("quick.day")} error={errors.localDate}>
            <input
              id="quick-date"
              className="field num"
              type="date"
              max={today}
              {...fieldAria("quick-date", errors.localDate)}
              value={localDate}
              onChange={(e) => setLocalDate(e.target.value)}
            />
          </Field>

          <p className="text-micro text-muted" aria-live="polite">
            {describeDay(localDate, today, LOCALE)}
          </p>

          {submitError ? (
            <p role="alert" className="text-note text-muted">
              {submitError}
            </p>
          ) : null}

          <button className="btn" type="submit" disabled={pending || saved}>
            {saved ? t("quick.saved") : pending ? t("quick.saving") : t("quick.save")}
          </button>
        </form>
      </div>
    </div>
  );
}
