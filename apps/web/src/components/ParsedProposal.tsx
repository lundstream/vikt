import { useState } from "react";
import type { FoodMatch } from "shared";
import { formatDecimal, formatKcal, formatPortion } from "shared";
import { fieldAria } from "./Field.js";
import { clientUuid } from "../lib/uuid.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { t } from "../i18n/index.js";

/**
 * The list a parse produces, before any of it is saved.
 *
 * One component for both ways in, because it is one view: a sentence and a
 * photograph produce the same rows, and the rules about what may be saved are
 * rules about the rows rather than about where they came from. It was the text
 * parser's own markup until the photo path needed it; extracting it was
 * cheaper than the alternative, which is two lists that drift and then
 * disagree about what an unpriced row is allowed to do.
 *
 * What it holds, in order of how easy it is to get wrong:
 *
 * **Nothing is saved until a person has read it.** Every row is editable and
 * removable, and the button is the only thing that writes.
 *
 * **A row with no amount cannot be saved, and does not stop the others**
 * (D143). A photograph often names a food and says nothing usable about how
 * much of it there was. That row shows the food, an empty field and "inte än"
 * where the figure would be; the rows that do have amounts save, and the ones
 * that do not stay on screen until somebody fills them in or takes them out.
 * Saving them with a guessed figure would be the app inventing a number and
 * attributing it to the person.
 *
 * **An unmatched row cannot be saved without a value** (D74). It used to be
 * written as a zero, which made the day's intake silently low in the one place
 * where the app is doing the writing rather than reporting.
 *
 * **Rows from a photograph are marked, in Sten with a dashed edge and a `≈`.**
 * The profile is explicit that uncertainty is not one of the five areas and
 * gets no accent of its own; the dash and the glyph say it as well as a colour
 * would, and the rule is that colour is never alone in saying what a thing is.
 */

export type ProposalItem = {
  clientUuid: string;
  foodItemId: string | null;
  name: string;
  grams: number;
  kcal?: number;
};

export function ParsedProposal({
  items,
  uncertain = false,
  intro,
  saving,
  onConfirm,
  onCancel,
  onReject,
  rejectLabel,
}: {
  items: FoodMatch[];
  /** True for a photograph: every amount is an estimate by origin. */
  uncertain?: boolean;
  intro: string;
  saving: boolean;
  /** Writes the rows. Resolves when they are saved. */
  onConfirm: (rows: ProposalItem[]) => Promise<void>;
  /** Every row is gone: the caller closes the panel. */
  onCancel: () => void;
  /** The text path's way out to D81's estimate. Absent on the photo path. */
  onReject?: () => void;
  rejectLabel?: string;
}) {
  /**
   * The rows still on screen. Saved rows leave; rows that could not be saved
   * stay, which is what makes a partial save legible rather than a silent one.
   */
  const [rows, setRows] = useState<FoodMatch[]>(items);
  const [grams, setGrams] = useState<Record<number, string>>(() => initialGrams(items));
  const [keep, setKeep] = useState<Set<number>>(() => new Set(items.map((_, i) => i)));
  /** What the user says an unmatched row is worth, by row (D74). */
  const [kcals, setKcals] = useState<Record<number, string>>({});
  const [note, setNote] = useState<string | null>(null);

  async function save() {
    const ready: ProposalItem[] = [];
    const readyIndexes = new Set<number>();
    /** Kept rows with nothing in the amount field. Reported, never guessed. */
    const withoutAmount: string[] = [];

    for (const [index, item] of rows.entries()) {
      if (!keep.has(index)) continue;

      const typed = (grams[index] ?? "").trim();
      if (typed === "") {
        withoutAmount.push(item.match?.name ?? item.name);
        continue;
      }

      const amount = readRequiredNumber(typed);
      if (!amount.ok) {
        setNote(amount.message);
        return;
      }

      let kcal: number | null = null;
      if (item.match === null) {
        const value = readRequiredNumber(kcals[index] ?? "");
        if (!value.ok) {
          setNote(t("llm.needsValue", { name: item.name }));
          return;
        }
        kcal = value.value;
      }

      ready.push({
        clientUuid: clientUuid(),
        foodItemId: item.match?.foodItemId ?? null,
        name: item.match?.name ?? item.name,
        grams: amount.value,
        ...(kcal === null ? {} : { kcal }),
      });
      readyIndexes.add(index);
    }

    if (ready.length === 0) {
      setNote(t("llm.noneWithAmount"));
      return;
    }

    await onConfirm(ready);

    const left = rows.filter((_, index) => !readyIndexes.has(index));
    if (left.length === 0) {
      onCancel();
      return;
    }

    /**
     * What is left is what could not be saved. Re-indexed from scratch, so the
     * state maps do not quietly point at the wrong rows.
     */
    setRows(left);
    setGrams(initialGrams(left));
    setKeep(new Set(left.map((_, index) => index)));
    setKcals({});
    setNote(t("llm.someWithoutAmount", { count: withoutAmount.length }));
  }

  return (
    <div className="panel mt-4" data-testid="parse-proposal">
      <p className="max-w-prose text-micro text-muted">{intro}</p>

      {note ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {note}
        </p>
      ) : null}

      <ul className="mt-3 space-y-3">
        {rows.map((item, index) => (
          <li
            key={`${item.name}-${index}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3"
          >
            <input
              type="checkbox"
              className="check"
              checked={keep.has(index)}
              onChange={() =>
                setKeep((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
              aria-label={t("llm.include", { name: item.match?.name ?? item.name })}
            />

            <span className="min-w-0">
              <span className="block truncate text-note text-ink">
                {item.match?.name ?? item.name}
                {uncertain ? (
                  <span className="tag tag-estimate ml-2 align-middle">
                    <span aria-hidden="true">≈</span>
                    {t("estimate.badge")}
                  </span>
                ) : null}
              </span>
              {/*
                Where both numbers came from. The portion is what was said and
                is never a claim about mass; the grams beside it came from a
                hint or a guess or from nowhere at all, and which one is stated
                rather than left to be inferred from a confidence figure.
              */}
              <span className="num block text-micro text-muted">
                {item.portion ? `${formatPortion(item.portion)} · ` : ""}
                {item.portionSource === "unknown"
                  ? t("llm.amountUnknown")
                  : item.portionSource === "estimate"
                    ? t("portion.estimated")
                    : t("portion.fromHint")}
              </span>
              <span className="num block text-micro text-muted">
                {item.match === null
                  ? t("llm.noMatch")
                  : item.match.kcal === null
                    ? t("llm.amountUnknown")
                    : t("llm.matched", { kcal: formatKcal(item.match.kcal) })}
              </span>
            </span>

            <span className="relative w-24">
              <input
                className={`field num pr-7 text-right${
                  item.estimatedGrams === null ? " border-dashed border-uncertain" : ""
                }`}
                type="text"
                inputMode="decimal"
                aria-label={t("food.grams")}
                value={grams[index] ?? ""}
                onChange={(event) =>
                  setGrams((current) => ({ ...current, [index]: event.target.value }))
                }
                {...fieldAria(`llm-grams-${index}`, undefined)}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-micro text-muted"
              >
                g
              </span>
            </span>

            {/*
              A row the database could not price cannot be saved until it has a
              figure (D74). Two ways to give it one, because both are real
              answers: type what it was worth, or say it was nothing, which is
              what a pinch of salt actually is.
            */}
            {item.match === null && keep.has(index) ? (
              <span className="col-span-3 flex items-center gap-2 pl-8">
                <span className="relative w-28">
                  <input
                    className="field num pr-10 text-right"
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={t("llm.valueFor", { name: item.name })}
                    value={kcals[index] ?? ""}
                    onChange={(event) =>
                      setKcals((current) => ({ ...current, [index]: event.target.value }))
                    }
                    {...fieldAria(`llm-kcal-${index}`, undefined)}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-micro text-muted"
                  >
                    kcal
                  </span>
                </span>
                <button
                  type="button"
                  data-testid={`negligible-${index}`}
                  className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
                  onClick={() => setKcals((current) => ({ ...current, [index]: "0" }))}
                >
                  {t("llm.negligible")}
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="confirm-parsed"
          className="btn w-auto px-4"
          onClick={() => void save()}
          disabled={saving || keep.size === 0}
        >
          {t("llm.saveRows", { count: keep.size })}
        </button>
        {onReject ? (
          <button
            type="button"
            data-testid="reject-parse"
            className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
            onClick={onReject}
          >
            {rejectLabel ?? t("llm.notRight")}
          </button>
        ) : null}
        <button
          type="button"
          className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

/** The amount field's starting value. Empty when nobody knows it yet (D143). */
function initialGrams(items: FoodMatch[]): Record<number, string> {
  return Object.fromEntries(
    items.map((item, index) => [
      index,
      item.estimatedGrams === null
        ? ""
        : formatDecimal(item.estimatedGrams, { decimals: 0 }),
    ]),
  );
}
