import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CreateWeightEntry, UpdateWeightEntry } from "shared";
import { createWeightEntrySchema, formatForInput, updateWeightEntrySchema } from "shared";
import { ApiError } from "../lib/api.js";
import {
  useDeleteManualIntake,
  useDeleteWeight,
  useManualIntakeLog,
  useSaveManualIntake,
  useSaveWeight,
  useUpdateWeight,
} from "../lib/log.js";
import { describeDay, formatLongDay } from "../lib/dates.js";
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
  /**
   * The day to open on. Defaults to today, which is the quick path (D145).
   *
   * Set by the readings list and the month calendar, where the sheet is not a
   * quick entry but the edit for a day somebody pointed at. The field is still
   * there and still editable: the day is a starting point, not a lock.
   */
  date?: string;
  /** Seeds the weight field instead of `lastWeightKg`. The day's own reading. */
  weightKg?: number | null;
  /**
   * The reading being edited, when there is one.
   *
   * Two jobs now (D150): it puts a delete on the screen that shows the row
   * (§3, D56), and it makes the save an **update** to that row rather than a
   * create for its day. `weightKg` above is the baseline that travels with it,
   * so the server can tell an edit arriving late from two devices disagreeing.
   */
  entryId?: string | null;
};

export function QuickLogSheet({
  open,
  timezone,
  onClose,
  today,
  lastWeightKg,
  todayIntakeKcal,
  date,
  weightKg: seedWeightKg,
  entryId = null,
}: QuickLogSheetProps) {
  // The zone matters: it decides which day an entry belongs to (D39), and the
  // queue stamps that at creation rather than at send time.
  const saveWeight = useSaveWeight(timezone);
  const updateWeight = useUpdateWeight(timezone);
  const saveIntake = useSaveManualIntake(timezone);
  const deleteIntake = useDeleteManualIntake();
  const manualLog = useManualIntakeLog();

  const deleteWeight = useDeleteWeight();

  const [weightKg, setWeightKg] = useState("");
  const [kcal, setKcal] = useState("");
  const [localDate, setLocalDate] = useState(date ?? today);
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
   * The weight the row held when this sheet opened (D150).
   *
   * A ref rather than state, and captured on open rather than read at submit:
   * the baseline is what the **person saw**, and reading the prop at submit
   * would pick up a background refetch that landed while they were typing,
   * which is exactly the change the baseline exists to notice.
   */
  const baselineRef = useRef<number | null>(null);

  /**
   * Reset and focus on the closed -> open transition only. Reacting to the
   * seed values as well would wipe what the user is typing whenever a
   * background refetch lands.
   */
  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;

    const openOn = date ?? today;
    baselineRef.current = seedWeightKg ?? null;
    setWeightKg(formatForInput(seedWeightKg === undefined ? lastWeightKg : seedWeightKg));
    /**
     * The intake for the day being opened, not for today (D145).
     *
     * Seeding today's figure while editing the third of September would put
     * today's calories on that day the moment somebody pressed save, and they
     * would have no way of knowing they had. The manual log is already loaded
     * for the delete below; this reads the same row.
     */
    const manualForDay =
      openOn === today
        ? todayIntakeKcal
        : (manualLog.data?.find((entry) => entry.localDate === openOn)?.kcal ?? null);
    setKcal(formatForInput(manualForDay, 0));
    setLocalDate(openOn);
    setErrors({});
    setSaved(false);
    saveWeight.reset();
    updateWeight.reset();
    saveIntake.reset();

    // A frame's delay: focusing before the sheet is laid out loses the keypad
    // on some Android browsers.
    const raf = requestAnimationFrame(() => {
      weightInput.current?.focus();
      weightInput.current?.select();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the guard above
  }, [open, today, date, seedWeightKg, lastWeightKg, todayIntakeKcal, manualLog.data]);

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

    /**
     * A create or an update, and which one is a property of the sheet (D150).
     *
     * Opened on a day that already has a reading, this is an **edit**: it
     * carries that row's id and the weight that was on screen when it opened,
     * so the server can tell it from another device's opinion about the same
     * day. Opened on an empty day, or from the quick action, it is a create.
     *
     * This used to always be a create with a fresh `clientUuid`, which is why
     * editing 24 August produced "two devices wrote this day" and a queued row
     * whose retry could never succeed.
     */
    const baseline = baselineRef.current;
    const editing = entryId !== null && baseline !== null;

    const parsed = editing
      ? updateWeightEntrySchema.safeParse({
          id: entryId,
          clientUuid: clientUuid(),
          localDate,
          baselineWeightKg: baseline,
          weightKg: weight.value,
        })
      : createWeightEntrySchema.safeParse({
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
      if (editing) {
        await updateWeight.mutateAsync(parsed.data as UpdateWeightEntry);
      } else {
        await saveWeight.mutateAsync(parsed.data as CreateWeightEntry);
      }
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

  const writeError = saveWeight.error ?? updateWeight.error;
  const submitError =
    writeError instanceof ApiError
      ? writeError.message
      : saveIntake.error instanceof ApiError
        ? saveIntake.error.message
        : writeError || saveIntake.error
          ? t("quick.unreachable")
          : null;

  const pending = saveWeight.isPending || updateWeight.isPending || saveIntake.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="scrim absolute"
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
            {entryId ? t("quick.editTitle") : t("quick.title")}
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
            label={localDate === today ? t("quick.calories") : t("quick.caloriesThatDay")}
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

          {/*
            The reading's own delete, on the screen that shows it (§3, D56).
            Only when there is one: on an empty day there is nothing to remove,
            and a control that would 404 is worse than no control.
          */}
          {entryId ? (
            <DeleteButton
              testId="delete-weight-entry"
              label={t("quick.removeReadingLabel", {
                day: formatLongDay(localDate, LOCALE),
              })}
              onDelete={async () => {
                await deleteWeight.mutateAsync(entryId);
                onClose();
              }}
            />
          ) : null}

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
