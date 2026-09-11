import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  ACTIVITY_TYPES,
  formatDecimal,
  formatSek,
  createActivitySchema,
  createDailyLogSchema,
  createMeasurementSchema,
  formatForInput,
  formatKcal,
  MEASUREMENT_SITES,
  sumOrNull,
  type MeasurementSite,
} from "shared";
import { ScaleInput } from "../components/ScaleInput.js";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "../components/Field.js";
import { DeleteButton } from "../components/DeleteButton.js";
import { DateSelector } from "../components/DateSelector.js";
import { HabitChecklist } from "../components/HabitChecklist.js";
import {
  useDayLog,
  useDeleteActivity,
  useSaveActivity,
  useSaveDailyLog,
  useDeleteDailyLog,
  useSaveMeasurement,
} from "../lib/daily.js";
import { useInsights } from "../lib/log.js";
import { useRemoveOffset, useSaveOffset } from "../lib/progress.js";
import { formatLongDay } from "../lib/dates.js";
import { useLogDate } from "../lib/log-date.js";
import { clientUuid } from "../lib/uuid.js";
import { readNumber } from "../lib/form-number.js";
import { ApiError } from "../lib/api.js";
import { LOCALE, t, type TranslationKey } from "../i18n/index.js";

/**
 * The daily screen — everything about a day, logged in one pass.
 *
 * The design constraint is tap count, the same one the food screen is built to
 * (phase 3). Concretely:
 *
 *  - **one save.** Ratings, sleep, steps, alcohol and the note are one form and
 *    one button. Four separate saves is four round trips and four moments to
 *    abandon halfway;
 *  - **ratings are buttons, not sliders.** One tap each, and readable at a
 *    glance afterwards;
 *  - **it opens filled in.** Logging a day is mostly amending it — sleep in the
 *    morning, energy at night — so the form loads what is already stored;
 *  - **measurements are folded away by default.** They are a weekly job, not a
 *    daily one, and having them open would put six empty fields between the
 *    ratings and the save button every single day;
 *  - **activity is its own small form**, because several sessions a day are
 *    normal and each is a separate row.
 *
 * Nothing here is required. A day where someone rated their energy and nothing
 * else is a real day, and a form that refuses it teaches people to invent the
 * rest (§3: there is no failure state).
 */

type Ratings = {
  sweat: number | null;
  energy: number | null;
  mood: number | null;
  hunger: number | null;
};

const EMPTY_RATINGS: Ratings = { sweat: null, energy: null, mood: null, hunger: null };

/** `waist` -> `waistCm`, the API's field name. */
const siteField = (site: MeasurementSite) => `${site}Cm` as const;

export function DailyLog() {
  /**
   * The day this screen is looking at, which is not necessarily today (D62).
   * `today` is kept separately because a few things genuinely mean *today*
   * rather than *the selected day*, and conflating them is how a backfill ends
   * up asking the server about the wrong window.
   */
  const { date: today, today: actualToday, isToday } = useLogDate();
  const day = useDayLog(today);
  const insights = useInsights(actualToday);

  const saveDaily = useSaveDailyLog();
  const saveMeasurement = useSaveMeasurement();
  const saveActivity = useSaveActivity();
  const deleteActivity = useDeleteActivity();
  const deleteDaily = useDeleteDailyLog();

  const [ratings, setRatings] = useState<Ratings>(EMPTY_RATINGS);
  const [sleepHours, setSleepHours] = useState("");
  const [steps, setSteps] = useState("");
  const [alcoholUnits, setAlcoholUnits] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [savedDaily, setSavedDaily] = useState(false);

  const [showMeasurements, setShowMeasurements] = useState(false);
  const [measurements, setMeasurements] = useState<Record<string, string>>({});
  const [measurementErrors, setMeasurementErrors] = useState<FieldErrors>({});
  const [savedMeasurement, setSavedMeasurement] = useState(false);

  const saveOffset = useSaveOffset();
  const removeOffset = useRemoveOffset();

  const [activityType, setActivityType] = useState<string>("walk");
  const [durationMin, setDurationMin] = useState("");
  const [intensity, setIntensity] = useState<number | null>(3);
  const [activityErrors, setActivityErrors] = useState<FieldErrors>({});

  /**
   * The form shows the loaded day, and **only** the loaded day.
   *
   * Two properties have to hold at once, and the first version had only one of
   * them.
   *
   * *Typing survives a refetch.* TanStack Query refetches on focus and hands
   * back a new object every time; seeding on object identity would wipe out
   * whatever was half-entered each time the app regained focus, which on a
   * phone is every time you check something else and come back. So the guard is
   * a ref holding a **version string**, and a refetch of unchanged data
   * produces the same string and touches nothing.
   *
   * *Changing the day resets the form.* The old guard bailed out when the day
   * had no stored row (`if (!stored) return`), so browsing from a filled day to
   * an empty one left the filled day's answers sitting in the inputs. That is
   * not cosmetic: the save button was right there, and pressing it would have
   * written Tuesday's sleep and mood onto a Wednesday nobody had logged. The
   * version therefore includes the **date**, and an absent row is a value —
   * `empty` — rather than a reason to skip.
   *
   * While a new day is loading the version is `loading`, which clears the form
   * immediately rather than showing the previous day's answers against the new
   * day's heading for as long as the request takes.
   */
  const seededDaily = useRef<string | null>(null);
  useEffect(() => {
    const stored = day.data?.daily ?? null;
    const version =
      day.data === undefined
        ? `${today}:loading`
        : `${today}:${stored?.loggedAt ?? "empty"}`;

    if (seededDaily.current === version) return;
    seededDaily.current = version;

    setRatings(
      stored
        ? {
            sweat: stored.sweat,
            energy: stored.energy,
            mood: stored.mood,
            hunger: stored.hunger,
          }
        : EMPTY_RATINGS,
    );
    setSleepHours(
      stored?.sleepHours == null ? "" : formatForInput(stored.sleepHours, 1),
    );
    setSteps(stored?.steps == null ? "" : String(stored.steps));
    setAlcoholUnits(
      stored?.alcoholUnits == null ? "" : formatForInput(stored.alcoholUnits, 1),
    );
    setNote(stored?.note ?? "");

    // A "Sparat" from another day has nothing to say about this one.
    setSavedDaily(false);
    setErrors({});
  }, [today, day.data]);

  const storedMeasurement = day.data?.measurement ?? null;
  const seededMeasurement = useRef<string | null>(null);
  useEffect(() => {
    const version =
      day.data === undefined
        ? `${today}:loading`
        : `${today}:${storedMeasurement?.loggedAt ?? "empty"}`;

    if (seededMeasurement.current === version) return;
    seededMeasurement.current = version;

    const next: Record<string, string> = {};
    for (const site of MEASUREMENT_SITES) {
      const value = storedMeasurement?.[siteField(site)];
      if (typeof value === "number") next[site] = formatForInput(value, 1);
    }
    setMeasurements(next);
    setMeasurementErrors({});
    setSavedMeasurement(false);

    // A stored measurement means the section is worth having open. An empty day
    // does not close it again: someone who opened it is probably about to type.
    if (storedMeasurement) setShowMeasurements(true);
  }, [today, day.data, storedMeasurement]);

  // Memoised for its identity: see the same pattern in Dashboard. The fallback
  // is a new array each render, and `activityKcalTotal` below depends on it.
  const activities = useMemo(() => day.data?.activities ?? [], [day.data?.activities]);

  /**
   * Null when no session on the day could be estimated — which happens whenever
   * there is no weight reading to scale MET by (D33). "0 kcal i dag" would claim
   * the training cost nothing; the truth is that it cannot be estimated.
   */
  const activityKcalTotal = useMemo(
    () =>
      sumOrNull(
        activities
          .map((entry) => entry.kcalEstimate)
          .filter((kcal): kcal is number => kcal !== null),
      ),
    [activities],
  );

  async function submitDaily(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setSavedDaily(false);

    const numbers: Record<string, number | null> = {};
    const problems: FieldErrors = {};

    for (const [name, raw] of [
      ["sleepHours", sleepHours],
      ["steps", steps],
      ["alcoholUnits", alcoholUnits],
    ] as const) {
      const parsed = readNumber(raw);
      if (!parsed.ok) problems[name] = parsed.message;
      else numbers[name] = parsed.value;
    }

    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }

    const parsed = createDailyLogSchema.safeParse({
      clientUuid: day.data?.daily?.clientUuid ?? clientUuid(),
      localDate: today,
      ...ratings,
      sleepHours: numbers.sleepHours ?? null,
      steps: typeof numbers.steps === "number" ? Math.round(numbers.steps) : null,
      alcoholUnits: numbers.alcoholUnits ?? null,
      note: note.trim() === "" ? null : note.trim(),
    });

    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    try {
      await saveDaily.mutateAsync(parsed.data);
      setSavedDaily(true);
    } catch (error) {
      setErrors({ form: messageFor(error) });
    }
  }

  async function submitMeasurement(event: FormEvent) {
    event.preventDefault();
    setMeasurementErrors({});
    setSavedMeasurement(false);

    const values: Record<string, number | null> = {};
    const problems: FieldErrors = {};

    for (const site of MEASUREMENT_SITES) {
      const parsed = readNumber(measurements[site] ?? "");
      if (!parsed.ok) problems[site] = parsed.message;
      else values[siteField(site)] = parsed.value;
    }

    if (Object.keys(problems).length > 0) {
      setMeasurementErrors(problems);
      return;
    }

    const parsed = createMeasurementSchema.safeParse({
      clientUuid: storedMeasurement?.clientUuid ?? clientUuid(),
      localDate: today,
      ...values,
    });

    if (!parsed.success) {
      // The API's field is `waistCm`; the message belongs under `waist`.
      const mapped: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "form").replace(/Cm$/, "");
        mapped[field] ??= issue.message;
      }
      setMeasurementErrors(mapped);
      return;
    }

    try {
      await saveMeasurement.mutateAsync(parsed.data);
      setSavedMeasurement(true);
    } catch (error) {
      setMeasurementErrors({ form: messageFor(error) });
    }
  }

  async function submitActivity(event: FormEvent) {
    event.preventDefault();
    setActivityErrors({});

    const duration = readNumber(durationMin, { required: true });
    if (!duration.ok) {
      setActivityErrors({ durationMin: duration.message });
      return;
    }

    const parsed = createActivitySchema.safeParse({
      clientUuid: clientUuid(),
      localDate: today,
      activityType,
      durationMin: Math.round(duration.value ?? 0),
      intensity,
    });

    if (!parsed.success) {
      setActivityErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    try {
      await saveActivity.mutateAsync(parsed.data);
      setDurationMin("");
    } catch (error) {
      setActivityErrors({ form: messageFor(error) });
    }
  }

  const exercise = insights.data?.exerciseAdjustment;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">{t("daily.title")}</h1>
          <p className="text-note text-muted">{t("daily.subtitle")}</p>
        </div>
        {/*
          The second way into the data viewer (D67). Here because this is where
          the ratings are entered, and "what does my sleep column actually look
          like" is the question you have while filling one in.
        */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Link className="text-note text-muted underline underline-offset-4" to="/">
            {t("nav.dashboard")}
          </Link>
          <Link
            className="text-micro text-muted underline underline-offset-4 hover:text-ink"
            to="/data"
          >
            {t("data.openLink")}
          </Link>
        </div>
      </header>

      {/*
        Which day. Everything below writes to it, and the API has always
        accepted any `local_date` — this screen simply never offered one.
      */}
      <div className="mb-6">
        <DateSelector label={t("dateSelector.dayLabel")} />
        {isToday ? null : (
          <p role="status" className="mt-2 text-micro text-muted">
            {t("dateSelector.notToday", { date: formatLongDay(today, LOCALE) })}
          </p>
        )}
      </div>

      {/* ------------------------------------------------------ the day */}
      <form onSubmit={submitDaily} noValidate>
        <div className="grid grid-cols-2 gap-x-4 gap-y-5">
          <ScaleInput
            id="energy"
            label={t("daily.energy")}
            value={ratings.energy}
            onChange={(energy) => setRatings((prev) => ({ ...prev, energy }))}
            lowLabel="daily.energyLow"
            highLabel="daily.energyHigh"
          />
          <ScaleInput
            id="mood"
            label={t("daily.mood")}
            value={ratings.mood}
            onChange={(mood) => setRatings((prev) => ({ ...prev, mood }))}
            lowLabel="daily.moodLow"
            highLabel="daily.moodHigh"
          />
          <ScaleInput
            id="sweat"
            label={t("daily.sweat")}
            value={ratings.sweat}
            onChange={(sweat) => setRatings((prev) => ({ ...prev, sweat }))}
            lowLabel="daily.sweatLow"
            highLabel="daily.sweatHigh"
          />
          <ScaleInput
            id="hunger"
            label={t("daily.hunger")}
            value={ratings.hunger}
            onChange={(hunger) => setRatings((prev) => ({ ...prev, hunger }))}
            lowLabel="daily.hungerLow"
            highLabel="daily.hungerHigh"
          />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {/*
            `type="text"` with `inputMode`, never `type="number"`: a number
            input silently discards the comma a Swedish keypad produces, so the
            locale-aware parser behind it never runs.
          */}
          <Field id="sleepHours" label={t("daily.sleep")} error={errors.sleepHours}>
            <input
              id="sleepHours"
              className="field num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={sleepHours}
              onChange={(event) => setSleepHours(event.target.value)}
              {...fieldAria("sleepHours", errors.sleepHours)}
            />
          </Field>
          <Field id="steps" label={t("daily.steps")} error={errors.steps}>
            <input
              id="steps"
              className="field num"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={steps}
              onChange={(event) => setSteps(event.target.value)}
              {...fieldAria("steps", errors.steps)}
            />
          </Field>
          <Field id="alcoholUnits" label={t("daily.alcohol")} error={errors.alcoholUnits}>
            <input
              id="alcoholUnits"
              className="field num"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={alcoholUnits}
              onChange={(event) => setAlcoholUnits(event.target.value)}
              {...fieldAria("alcoholUnits", errors.alcoholUnits)}
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field id="note" label={t("daily.note")} error={errors.note}>
            <textarea
              id="note"
              className="field min-h-[68px] resize-y"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              {...fieldAria("note", errors.note)}
            />
          </Field>
        </div>

        {errors.form ? (
          <p role="alert" className="mt-3 text-note text-ink">
            {errors.form}
          </p>
        ) : null}

        {/*
          Filled, like the other two saves on this screen (D134).

          Dagen is three parallel forms — the day's ratings, an activity, a
          measurement — each with its own submit, and none of them is the one
          that matters. That used to be said with an outline, on the reasoning
          that a filled button among outlines would claim a precedence it does
          not have. The outline tier is gone: three equal actions are three
          equal buttons, which says the same thing without spending a visual
          tier on it, and nothing here is a cancel.
        */}
        <button
          type="submit"
          data-testid="save-day"
          /* The screen's primary action: Snö on Natt (profile, page 6). */
          className="btn mt-5"
          disabled={saveDaily.isPending}
        >
          {saveDaily.isPending ? t("daily.saving") : t("daily.save")}
        </button>

        {savedDaily ? (
          <p role="status" className="mt-2 text-center text-note text-logged">
            {t("daily.saved")}
          </p>
        ) : null}

        {/*
          Only once there is something stored. Offering to delete a day that has
          never been saved is a control that does nothing, and a control that
          does nothing is worse than an absent one.
        */}
        {day.data?.daily ? (
          <p className="mt-3 text-center">
            <DeleteButton
              testId="delete-day"
              label={t("daily.title")}
              onDelete={async () => {
                await deleteDaily.mutateAsync(day.data!.daily!.id);
                setRatings(EMPTY_RATINGS);
                setSleepHours("");
                setSteps("");
                setAlcoholUnits("");
                setNote("");
                setSavedDaily(false);
                // The form is seeded once per stored version, so the guard has
                // to be released or a re-saved day would not re-seed it.
                seededDaily.current = null;
              }}
            />
          </p>
        ) : null}
      </form>

      {/* ------------------------------------------------------- vanor */}

      {/*
        The checklist (D137), beside the daily log rather than on a screen of
        its own: it is part of "what happened today", which is what this screen
        already is, and a separate page would make a habit a thing you go and do
        rather than a thing you tick while you are here anyway.

        Above the savings offsets and below the day's own form, because the
        ratings are what most days are opened for and a list of five rows must
        not push them down the screen.
      */}
      <HabitChecklist habits={day.data?.habits ?? []} localDate={today} />

      {/* ----------------------------------------------------- savings */}

      {/*
        D37. "I did buy the lunch after all" lives here, inside the one pass
        that already happens every day, rather than on the savings screen. An
        offset that needs its own errand is one nobody files, and a pot with
        unfiled offsets is fiction that reads as money.

        Only rules whose cadence matched today appear, so this is never a menu
        of things that did not happen. One tap per rule, no confirmation.
      */}
      {(day.data?.savingsRules ?? []).length > 0 ? (
        <section className="mt-10">
          <h2 className="text-base text-ink">{t("offset.title")}</h2>
          <p className="mt-1 max-w-prose text-micro text-muted">{t("offset.note")}</p>

          <ul className="mt-3 divide-y divide-edge border-y border-edge">
            {(day.data?.savingsRules ?? []).map((rule) => (
              <li key={rule.id} className="flex items-center gap-3 py-2.5">
                <span className="flex-1 text-note text-ink">
                  {rule.label}
                  <span className="num ml-2 text-muted">{formatSek(rule.amountSek)}</span>
                </span>
                <button
                  type="button"
                  data-testid={`offset-${rule.id}`}
                  aria-pressed={rule.offsetToday}
                  /**
                   * A row action, so the small filled button (D134). It writes
                   * something, which is what makes it a button rather than a
                   * link, and it lives in a row, which is what makes it small.
                   *
                   * Pressed is Gran, and stays Gran: the profile is explicit
                   * that a chosen control is the logged colour, because chosen
                   * *is* logged. That is the one state that is not Snö on Natt.
                   */
                  className={`btn-small ${
                    rule.offsetToday ? "bg-logged text-paper" : ""
                  }`}
                  onClick={() =>
                    void (rule.offsetToday
                      ? removeOffset.mutateAsync({ ruleId: rule.id, localDate: today })
                      : saveOffset.mutateAsync({ ruleId: rule.id, localDate: today }))
                  }
                >
                  {rule.offsetToday ? t("offset.bought") : t("offset.markBought")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------------------------------------------- activity */}
      <section className="mt-10">
        <h2 className="text-base text-ink">{t("activity.title")}</h2>

        {/*
          D33, said in the UI in the words the decision asks for. This screen is
          the only place the estimate is shown, and it says what it is for.
        */}
        <p className="mt-1 text-micro text-muted">{t("activity.estimateNote")}</p>

        {activities.length > 0 ? (
          <ul className="mt-3 divide-y divide-edge border-y border-edge">
            {activities.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2.5">
                <span className="flex-1 text-note text-ink">
                  {t(`activity.type.${entry.activityType}` as TranslationKey)}
                  <span className="num ml-2 text-muted">
                    {formatDecimal(entry.durationMin, { decimals: 0 })} min
                  </span>
                </span>
                <span className="num text-note text-muted">
                  {entry.kcalEstimate === null
                    ? t("activity.noEstimate")
                    : t("activity.approxKcal", { kcal: formatKcal(entry.kcalEstimate) })}
                </span>
                <button
                  type="button"
                  // Padded to a real target: a 16 px text link is not something
                  // anyone hits reliably with a thumb.
                  className="-mr-2 px-2 py-2.5 text-micro text-muted underline underline-offset-4"
                  onClick={() => void deleteActivity.mutateAsync(entry.id)}
                >
                  {t("activity.remove")}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {activities.length > 0 && activityKcalTotal !== null ? (
          <p className="num mt-2 text-micro text-muted">
            {t("activity.dayTotal", { kcal: formatKcal(activityKcalTotal) })}
          </p>
        ) : null}

        <form onSubmit={submitActivity} noValidate className="mt-4">
          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <Field id="activityType" label={t("activity.type")}>
              <select
                id="activityType"
                className="select"
                value={activityType}
                onChange={(event) => setActivityType(event.target.value)}
              >
                {ACTIVITY_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`activity.type.${type}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id="durationMin"
              label={t("activity.duration")}
              error={activityErrors.durationMin}
            >
              <input
                id="durationMin"
                className="field num"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={durationMin}
                onChange={(event) => setDurationMin(event.target.value)}
                {...fieldAria("durationMin", activityErrors.durationMin)}
              />
            </Field>
          </div>

          <div className="mt-4">
            <ScaleInput
              id="intensity"
              label={t("activity.intensity")}
              value={intensity}
              onChange={setIntensity}
              lowLabel="activity.intensityLow"
              highLabel="activity.intensityHigh"
            />
          </div>

          {activityErrors.form ? (
            <p role="alert" className="mt-3 text-note text-ink">
              {activityErrors.form}
            </p>
          ) : null}

          <button
            type="submit"
            data-testid="add-activity"
            className="btn mt-4"
            disabled={saveActivity.isPending}
          >
            {t("activity.add")}
          </button>
        </form>

        {/*
          Which case is in force, stated rather than implied (D31). The toggle
          itself lives on the profile screen; this is the screen where the
          consequence shows up, so this is where it has to be legible.
        */}
        {exercise ? (
          <p className="mt-3 text-micro text-muted">
            {exercise.reason === "adaptive_includes_activity"
              ? t("activity.adaptiveIncludes")
              : exercise.inForce
                ? t("activity.addedToTarget")
                : t("activity.notAddedToTarget")}
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------ measurements */}
      <section className="mt-10">
        {/*
          A heading wrapping the disclosure button, so the section is reachable
          by heading navigation like the others rather than being an unlabelled
          button in the outline.
        */}
        <h2>
          <button
            type="button"
            data-testid="toggle-measurements"
            className="flex w-full items-center justify-between border-b border-edge pb-2 pt-1 text-left"
            onClick={() => setShowMeasurements((open) => !open)}
            aria-expanded={showMeasurements}
          >
            <span className="text-base text-ink">{t("measure.title")}</span>
            <span className="text-micro text-muted">
              {showMeasurements ? t("measure.hide") : t("measure.show")}
            </span>
          </button>
        </h2>

        {showMeasurements ? (
          <form onSubmit={submitMeasurement} noValidate className="mt-4">
            <p className="mb-3 text-micro text-muted">{t("measure.smoothingNote")}</p>

            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
              {MEASUREMENT_SITES.map((site) => (
                <Field
                  key={site}
                  id={site}
                  label={t(`measure.${site}` as TranslationKey)}
                  error={measurementErrors[site]}
                >
                  <input
                    id={site}
                    className="field num"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={measurements[site] ?? ""}
                    onChange={(event) =>
                      setMeasurements((prev) => ({ ...prev, [site]: event.target.value }))
                    }
                    {...fieldAria(site, measurementErrors[site])}
                  />
                </Field>
              ))}
            </div>

            {measurementErrors.form ? (
              <p role="alert" className="mt-3 text-note text-ink">
                {measurementErrors.form}
              </p>
            ) : null}

            <button
              type="submit"
              data-testid="save-measurement"
              className="btn mt-4"
              disabled={saveMeasurement.isPending}
            >
              {saveMeasurement.isPending ? t("daily.saving") : t("measure.save")}
            </button>

            {savedMeasurement ? (
              <p role="status" className="mt-2 text-center text-note text-logged">
                {t("measure.saved")}
              </p>
            ) : null}
          </form>
        ) : null}
      </section>
    </main>
  );
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return t("auth.unreachable");
}
