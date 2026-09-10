import { useState, type FormEvent } from "react";
import type { PreviewSavingsRule, SavingsRuleDto, SavingsRulePreviewDto } from "shared";
import { formatDecimal, formatSek, updateSavingsRuleSchema } from "shared";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "./Field.js";
import { readNumber } from "../lib/form-number.js";
import {
  useDeleteSavingsRule,
  usePreviewSavingsRule,
  useUpdateSavingsRule,
} from "../lib/progress.js";
import { ApiError } from "../lib/api.js";
import { t, type TranslationKey } from "../i18n/index.js";

/**
 * The rules behind the pot, editable and deletable.
 *
 * They were the last log type without either. Weight, food and the daily log
 * all got edit and delete in the six-fix pass; a savings rule was still
 * write-once, so a typo in the amount was permanent and a rule someone stopped
 * following stayed in the pot forever.
 *
 * What makes this different from those three, and why it is not just a delete
 * button: **the pot accrues on read** (§4.5). No per-day rows are written, so
 * the rule *is* the record, and changing it changes the past. Moving a start
 * date back three months does not adjust anything going forward — it makes
 * three months of savings appear. Deleting a rule does not stop it; it removes
 * everything it ever added.
 *
 * That is correct behaviour and a surprising one, so the consequence is shown
 * as a figure before the change is saved (D54). The preview is computed by the
 * server with the same function that computes the real balance, on the real
 * rows, so what it promises is what happens.
 */
const CADENCES = ["every_day", "weekday", "weekend_day", "per_event"] as const;

export function SavingsRules({ rules, today }: { rules: SavingsRuleDto[]; today: string }) {
  if (rules.length === 0) return null;

  return (
    <ul className="mt-4 divide-y divide-edge border-y border-edge">
      {rules.map((rule) => (
        <RuleRow key={rule.id} rule={rule} today={today} />
      ))}
    </ul>
  );
}

type Mode = "idle" | "editing" | "confirming";

function RuleRow({ rule, today }: { rule: SavingsRuleDto; today: string }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [label, setLabel] = useState(rule.label);
  const [amountSek, setAmountSek] = useState(formatDecimal(rule.amountSek, { decimals: 0 }));
  const [cadence, setCadence] = useState<string>(rule.cadence);
  const [startDate, setStartDate] = useState(rule.startDate);
  const [errors, setErrors] = useState<FieldErrors>({});

  /** What is being confirmed: the edit above, or deleting the rule outright. */
  const [pending, setPending] = useState<{
    next: PreviewSavingsRule["next"];
    preview: SavingsRulePreviewDto;
  } | null>(null);

  const preview = usePreviewSavingsRule();
  const update = useUpdateSavingsRule();
  const remove = useDeleteSavingsRule();

  function reset() {
    setMode("idle");
    setPending(null);
    setErrors({});
    setLabel(rule.label);
    setAmountSek(formatDecimal(rule.amountSek, { decimals: 0 }));
    setCadence(rule.cadence);
    setStartDate(rule.startDate);
  }

  async function ask(next: PreviewSavingsRule["next"]) {
    setErrors({});
    try {
      const result = await preview.mutateAsync({ id: rule.id, input: { asOf: today, next } });
      setPending({ next, preview: result });
      setMode("confirming");
    } catch (error) {
      setErrors({ form: error instanceof ApiError ? error.message : t("auth.unreachable") });
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    const amount = readNumber(amountSek, { required: true });
    if (!amount.ok) {
      setErrors({ amountSek: amount.message });
      return;
    }

    const parsed = updateSavingsRuleSchema.safeParse({
      label: label.trim(),
      amountSek: amount.value,
      cadence,
      startDate,
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    await ask(parsed.data);
  }

  async function confirm() {
    if (!pending) return;
    try {
      if (pending.next === null) {
        await remove.mutateAsync(rule.id);
      } else {
        await update.mutateAsync({ id: rule.id, input: pending.next });
      }
      reset();
    } catch (error) {
      setErrors({ form: error instanceof ApiError ? error.message : t("auth.unreachable") });
    }
  }

  const busy = update.isPending || remove.isPending || preview.isPending;

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-note text-ink">{rule.label}</span>
          <span className="num block text-micro text-muted">
            {t("pot.ruleSummary", {
              amount: formatSek(rule.amountSek),
              cadence: t(`cadence.${rule.cadence}` as TranslationKey),
              days: rule.eligibleDays,
            })}
          </span>
        </span>

        <span className="num shrink-0 text-note text-ink">{formatSek(rule.accruedSek)}</span>

        {mode === "idle" ? (
          <button
            type="button"
            data-testid={`edit-rule-${rule.id}`}
            className="min-h-11 shrink-0 px-1 text-micro text-muted underline underline-offset-4 hover:text-ink"
            onClick={() => setMode("editing")}
          >
            {t("common.edit")}
          </button>
        ) : (
          <button
            type="button"
            className="min-h-11 shrink-0 px-1 text-micro text-muted underline underline-offset-4 hover:text-ink"
            onClick={reset}
          >
            {t("common.cancel")}
          </button>
        )}
      </div>

      {mode === "editing" ? (
        <form onSubmit={onSubmit} noValidate className="mt-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field id={`er-label-${rule.id}`} label={t("pot.ruleLabel")} error={errors.label}>
              <input
                id={`er-label-${rule.id}`}
                className="field"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                {...fieldAria(`er-label-${rule.id}`, errors.label)}
              />
            </Field>
            <Field id={`er-amount-${rule.id}`} label={t("pot.amount")} error={errors.amountSek}>
              <input
                id={`er-amount-${rule.id}`}
                className="field num"
                type="text"
                inputMode="decimal"
                value={amountSek}
                onChange={(event) => setAmountSek(event.target.value)}
                {...fieldAria(`er-amount-${rule.id}`, errors.amountSek)}
              />
            </Field>
            <Field id={`er-cadence-${rule.id}`} label={t("pot.cadence")}>
              <select
                id={`er-cadence-${rule.id}`}
                className="select"
                value={cadence}
                onChange={(event) => setCadence(event.target.value)}
              >
                {CADENCES.map((name) => (
                  <option key={name} value={name}>
                    {t(`cadence.${name}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={`er-start-${rule.id}`} label={t("pot.startDate")} error={errors.startDate}>
              <input
                id={`er-start-${rule.id}`}
                className="field num"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                {...fieldAria(`er-start-${rule.id}`, errors.startDate)}
              />
            </Field>
          </div>

          {errors.form ? (
            <p role="alert" className="mt-2 text-note text-ink">
              {errors.form}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="submit"
              data-testid={`preview-rule-${rule.id}`}
              className="btn"
              disabled={busy}
            >
              {t("pot.reviewChange")}
            </button>
            <button
              type="button"
              data-testid={`delete-rule-${rule.id}`}
              className="min-h-11 px-1 text-note text-muted underline underline-offset-4 hover:text-ink"
              onClick={() => void ask(null)}
              disabled={busy}
            >
              {t("pot.deleteRule")}
            </button>
          </div>
        </form>
      ) : null}

      {mode === "confirming" && pending ? (
        <ConsequenceNotice
          preview={pending.preview}
          deleting={pending.next === null}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={reset}
          error={errors.form}
        />
      ) : null}
    </li>
  );
}

/**
 * What the change will do, before it is saved.
 *
 * States the delta *and* both balances. A delta alone hides the scale — "−400
 * kr" reads very differently against a pot of 500 than against one of 12 000 —
 * and the whole point of this screen is that the balance is the number people
 * care about.
 *
 * Not styled as a warning. Editing a rule is a legitimate thing to do and often
 * a correction of an earlier mistake; §3 has no failure state, and colouring
 * this red would make fixing a typo feel like breaking something.
 */
function ConsequenceNotice({
  preview,
  deleting,
  busy,
  onConfirm,
  onCancel,
  error,
}: {
  preview: SavingsRulePreviewDto;
  deleting: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  error?: string;
}) {
  const unchanged = Math.abs(preview.deltaSek) < 0.005;

  return (
    <div
      role="status"
      data-testid="rule-consequence"
      className="mt-3 rounded-lg border border-edge bg-card p-4"
    >
      <p className="text-note text-ink">
        {deleting ? t("pot.confirmDeleteTitle") : t("pot.confirmEditTitle")}
      </p>

      <p className="num mt-2 max-w-prose text-note text-muted">
        {unchanged
          ? t("pot.potUnchanged", { balance: formatSek(preview.currentBalanceSek) })
          : t("pot.potMovesTo", {
              from: formatSek(preview.currentBalanceSek),
              to: formatSek(preview.nextBalanceSek),
              delta: formatSek(Math.abs(preview.deltaSek)),
            })}
      </p>

      {/*
        Days, not only kronor. A cadence change is easiest to understand as
        "these many days counted, now these many do", and the money follows
        from it rather than the other way round.
      */}
      {preview.currentEligibleDays !== preview.nextEligibleDays ? (
        <p className="num mt-1.5 max-w-prose text-micro text-muted">
          {t("pot.daysChange", {
            from: preview.currentEligibleDays,
            to: preview.nextEligibleDays,
          })}
        </p>
      ) : null}

      {/*
        The consequence that is not about money. The pot exists to make a reward
        reachable, so a change that quietly puts one back out of reach is the
        thing someone would otherwise find out weeks later.
      */}
      {preview.wouldUnaffordReward ? (
        <p className="mt-1.5 max-w-prose text-micro text-muted">{t("pot.rewardOutOfReach")}</p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-note text-ink">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="confirm-rule-change"
          className="btn-link"
          onClick={onConfirm}
          disabled={busy}
        >
          {deleting ? t("pot.confirmDelete") : t("pot.confirmEdit")}
        </button>
        <button
          type="button"
          className="min-h-11 px-1 text-note text-muted underline underline-offset-4 hover:text-ink"
          onClick={onCancel}
          disabled={busy}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
