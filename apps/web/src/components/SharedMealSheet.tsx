import { useState, type FormEvent } from "react";
import type { SharedMeal } from "shared";
import { formatDecimal, formatKcal } from "shared";
import { useCopySharedMeal, useLogSharedMeal, useReportSharedMeal } from "../lib/food.js";
import { useLogDate } from "../lib/log-date.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { ApiError } from "../lib/api.js";
import { clientUuid } from "../lib/uuid.js";
import { Field, fieldAria } from "./Field.js";
import { MealFigures, formatPortions } from "./MealFigures.js";
import { t } from "../i18n/index.js";

/**
 * A meal somebody else here shared, as its reader sees it (D192).
 *
 * Read-only: the rows, the photo, the figures per portion, and whose it is by
 * display name. Two actions, both of which **copy it into the reader's own
 * meals as a snapshot**: saving it, and logging it at some number of portions.
 * From then on the copy is theirs, and nothing the author does to theirs
 * changes it or any day it was logged on. A third, quieter, reports it.
 */
export function SharedMealSheet({
  meal,
  onDone,
}: {
  meal: SharedMeal;
  onDone: (message: string) => void;
}) {
  const copy = useCopySharedMeal();
  const log = useLogSharedMeal();
  const report = useReportSharedMeal();
  const { date: today } = useLogDate();

  const [portions, setPortions] = useState("1");
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reported, setReported] = useState(false);

  const fail = (problem: unknown) =>
    setError(problem instanceof ApiError ? problem.message : t("save.failed"));

  async function save() {
    setError(null);
    try {
      await copy.mutateAsync({ mealId: meal.id, clientUuid: clientUuid() });
      onDone(t("meals.copySaved", { name: meal.name }));
    } catch (problem) {
      fail(problem);
    }
  }

  async function logIt(event: FormEvent) {
    event.preventDefault();
    const parsed = readRequiredNumber(portions);
    if (!parsed.ok || parsed.value <= 0) {
      setError(parsed.ok ? t("meals.portionsPositive") : parsed.message);
      return;
    }
    setError(null);
    try {
      await log.mutateAsync({
        mealId: meal.id,
        input: { clientUuid: clientUuid(), localDate: today, portions: parsed.value },
      });
      onDone(t("meals.loggedShared", { name: meal.name, portions: formatPortions(parsed.value) }));
    } catch (problem) {
      fail(problem);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) return;
    try {
      await report.mutateAsync({ mealId: meal.id, reason: reason.trim() });
      setReported(true);
      setReporting(false);
    } catch (problem) {
      fail(problem);
    }
  }

  return (
    <div data-testid="shared-meal-sheet">
      {meal.photoUrl ? (
        <img
          src={meal.photoUrl}
          alt={t("meals.photoAlt", { name: meal.name })}
          className="mb-4 max-h-64 w-full rounded-lg object-cover"
        />
      ) : null}
      <p className="text-micro text-muted">
        {t("meals.fromAuthor", { name: meal.authorName })} · {formatPortions(meal.portions)}
      </p>
      <div className="mt-2">
        <MealFigures figures={meal.perPortion} />
      </div>

      <ul className="mt-4 divide-y divide-edge border-y border-edge">
        {meal.items.map((item) => (
          <li key={item.id} className="flex items-baseline justify-between gap-3 py-2">
            <span className="min-w-0 truncate text-note text-ink">{item.name}</span>
            <span className="num shrink-0 text-micro text-muted">
              {item.unit === "g"
                ? `${formatDecimal(item.grams, { decimals: 0 })} g`
                : `${formatDecimal(item.amount, { decimals: Number.isInteger(item.amount) ? 0 : 1 })} ${item.unit}`}
              {item.food ? ` · ${formatKcal((item.food.kcalPer100 * item.grams) / 100)} kcal` : ""}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 max-w-prose text-micro text-muted">{t("meals.sharedIntro")}</p>

      {error ? (
        <p role="alert" className="mt-3 text-note text-ink">
          {error}
        </p>
      ) : null}

      <form onSubmit={logIt} className="mt-4 flex flex-wrap items-end gap-3" noValidate>
        <div className="w-28">
          <Field id="shared-portions" label={t("meals.portions")}>
            <input
              id="shared-portions"
              className="field num"
              type="text"
              inputMode="decimal"
              {...fieldAria("shared-portions", undefined)}
              value={portions}
              onChange={(event) => setPortions(event.target.value)}
            />
          </Field>
        </div>
        <button type="submit" data-testid="shared-log" className="btn w-auto px-4" disabled={log.isPending}>
          {t("meals.logShared")}
        </button>
        <button
          type="button"
          data-testid="shared-save"
          className="btn w-auto px-4"
          disabled={copy.isPending}
          onClick={() => void save()}
        >
          {t("meals.saveCopy")}
        </button>
      </form>

      <div className="mt-6 border-t border-edge pt-3">
        {reported ? (
          <p role="status" className="text-micro text-muted" data-testid="shared-reported">
            {t("meals.reported")}
          </p>
        ) : reporting ? (
          <form onSubmit={send} className="space-y-2">
            <label className="block text-micro text-muted" htmlFor="report-reason">
              {t("meals.reportReason")}
            </label>
            <textarea
              id="report-reason"
              className="field min-h-20"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                data-testid="shared-report-send"
                className="btn-small"
                disabled={reason.trim().length < 3 || report.isPending}
              >
                {t("meals.reportSend")}
              </button>
              <button type="button" className="btn-link" onClick={() => setReporting(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            data-testid="shared-report"
            className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
            onClick={() => setReporting(true)}
          >
            {t("meals.report")}
          </button>
        )}
      </div>
    </div>
  );
}
