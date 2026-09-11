import { useState, type FormEvent } from "react";
import type { FoodMatch } from "shared";
import { formatDecimal, formatKcal, formatPortion } from "shared";
import { fieldAria } from "./Field.js";
import { useConfirmParsedFood, useLlmHealth, useParseFood } from "../lib/food.js";
import { clientUuid } from "../lib/uuid.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { EstimateEntry } from "./EstimateEntry.js";
import { t } from "../i18n/index.js";

/**
 * Logging a meal by describing it (§6 phase 8).
 *
 * Three properties, each of which is a rule from the brief rather than a
 * preference.
 *
 * **It is not here when the layer is not.** The workstation is not always on,
 * and nothing may depend on it, so this renders nothing at all unless the
 * health check says the host answered. Not a disabled control, not a message
 * saying the feature is unavailable: **no error banner** is the brief's phrase,
 * and the most complete way to honour it is for the screen to look exactly as
 * it did before the phase existed.
 *
 * **Nothing is saved until a person has read it.** The model returns names and
 * portions; the server matches the names against `food_items` and computes the
 * calories from there. What comes back is a proposal, shown with every portion
 * editable, and only the confirm button writes anything. A mis-parsed portion
 * that had been logged first would already be inside the intake series, and
 * from there inside the maintenance figure and both projections.
 *
 * **An unmatched food is kept as a note, once it has a value.** It is logged
 * with its name and the energy the user gave it, so the day still records that
 * something was eaten. It used to be logged as a zero, which recorded that
 * something was eaten and that it was worth nothing, and fed a silently low day
 * into the series TDEE is computed from (D74).
 *
 * It renders as the body of a sheet rather than a block on the food screen. The
 * screen had six of those competing, and this is a tool for the odd meal that
 * does not fit the fast paths, not one of the fast paths.
 *
 * **This is also the composed-meal path** (§3c, D81). "Torsk med kokt potatis,
 * gräddsås och broccoli" is a shopping list in different words, and the
 * decomposition it already does is exactly what a restaurant plate needs: the
 * dish becomes component rows with estimated portions, each matched against the
 * database, nutrition from the database as always. No rule changes; the
 * existing path is pointed at a new kind of input.
 *
 * When decomposition genuinely cannot help — a named chain burger, a pizzeria
 * pizza — the way out is the estimate path, and it is offered *here*, after the
 * attempt, because "decomposition was tried and did not work" is one of the
 * conditions that licenses a model estimate at all (D81).
 */
export function FoodTextEntry({
  localDate,
  onLogged,
}: {
  localDate: string;
  onLogged: (message: string) => void;
}) {
  const health = useLlmHealth();
  const parse = useParseFood();
  const confirm = useConfirmParsedFood();

  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<FoodMatch[] | null>(null);
  const [grams, setGrams] = useState<Record<number, string>>({});
  const [keep, setKeep] = useState<Set<number>>(new Set());
  /** What the user says an unmatched row is worth, by row (D74). */
  const [kcals, setKcals] = useState<Record<number, string>>({});
  const [note, setNote] = useState<string | null>(null);
  /**
   * What the app tried before giving up, which is what licenses an estimate.
   *
   * Null while there is still a normal path to take. Set only by an actual
   * failed attempt, never by opening the screen, because the whole point of
   * D81's conditions is that they describe events rather than intentions.
   */
  const [exhausted, setExhausted] = useState<
    "decomposed_empty" | "decomposed_rejected" | null
  >(null);

  /**
   * The one condition. `reachable` rather than `configured`: a host that is
   * configured and switched off is exactly the case the brief is about.
   */
  if (!health.data?.reachable) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setNote(null);

    const result = await parse.mutateAsync(text.trim());

    if (!result.available) {
      /**
       * The box went off between the health check and now. Still not an error:
       * the text stays in the box and the note says the manual path is there,
       * which is the same tone the offline notices use (D43).
       */
      setNote(t("llm.unavailableNow"));
      return;
    }

    if (result.items.length === 0) {
      /**
       * Decomposition produced nothing. That is the first of D81's conditions,
       * so the estimate path opens from here rather than being hunted for.
       */
      setNote(t("llm.nothingFound"));
      setExhausted("decomposed_empty");
      return;
    }

    setProposal(result.items);
    setGrams(
      Object.fromEntries(
        result.items.map((item, index) => [
          index,
          formatDecimal(item.estimatedGrams, { decimals: 0 }),
        ]),
      ),
    );
    setKeep(new Set(result.items.map((_, index) => index)));
    setKcals({});
  }

  async function save() {
    if (!proposal) return;

    const items = [];
    for (const [index, item] of proposal.entries()) {
      if (!keep.has(index)) continue;
      const amount = readRequiredNumber(grams[index] ?? "");
      if (!amount.ok) {
        setNote(amount.message);
        return;
      }
      /**
       * An unmatched row cannot be saved without a value (D74). It used to be
       * written as a zero, which made the day's intake silently low.
       */
      let kcal: number | null = null;
      if (item.match === null) {
        const typed = kcals[index] ?? "";
        const value = readRequiredNumber(typed);
        if (!value.ok) {
          setNote(t("llm.needsValue", { name: item.name }));
          return;
        }
        kcal = value.value;
      }

      items.push({
        clientUuid: clientUuid(),
        foodItemId: item.match?.foodItemId ?? null,
        name: item.match?.name ?? item.name,
        grams: amount.value,
        ...(kcal === null ? {} : { kcal }),
      });
    }

    if (items.length === 0) return;

    await confirm.mutateAsync({ localDate, mealSlot: "snack", items });
    reset();
    onLogged(t("llm.logged", { count: items.length }));
  }

  function reset() {
    setText("");
    setProposal(null);
    setGrams({});
    setKeep(new Set());
    setKcals({});
    setNote(null);
    setExhausted(null);
  }

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          id="llm-text"
          className="field flex-1"
          placeholder={t("llm.placeholder")}
          aria-label={t("llm.title")}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={parse.isPending}
        />
        <button
          type="submit"
          data-testid="parse-food"
          className="btn w-auto  disabled:opacity-50"
          disabled={text.trim().length < 2 || parse.isPending}
        >
          {parse.isPending ? t("llm.reading") : t("llm.read")}
        </button>
      </form>

      {note ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {note}
        </p>
      ) : null}

      {proposal ? (
        <div className="panel mt-4" data-testid="parse-proposal">
          <p className="max-w-prose text-micro text-muted">{t("llm.checkBeforeSaving")}</p>

          <ul className="mt-3 space-y-3">
            {proposal.map((item, index) => (
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
                  </span>
                  {/*
                    Where both numbers came from. The portion is what the user
                    said and is never a claim about mass; the grams beside it
                    came from a hint or from a guess, and which one is stated
                    rather than left to be inferred from confidence.
                  */}
                  <span className="num block text-micro text-muted">
                    {item.portion ? `${formatPortion(item.portion)} · ` : ""}
                    {item.portionSource === "estimate"
                      ? t("portion.estimated")
                      : t("portion.fromHint")}
                  </span>
                  <span className="num block text-micro text-muted">
                    {item.match
                      ? t("llm.matched", { kcal: formatKcal(item.match.kcal) })
                      : t("llm.noMatch")}
                  </span>
                </span>

                <span className="relative w-24">
                  <input
                    className="field num pr-7 text-right"
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
                  A row the database could not price cannot be saved until it
                  has a figure (D74). Two ways to give it one, because both are
                  real answers: type what it was worth, or say it was nothing,
                  which is what a pinch of salt actually is.
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
              disabled={confirm.isPending || keep.size === 0}
            >
              {t("llm.saveRows", { count: keep.size })}
            </button>
            <button
              type="button"
              data-testid="reject-parse"
              className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
              onClick={() => {
                // Looking at the decomposition and saying no is D81's other
                // condition. Recorded here, where it actually happened.
                setProposal(null);
                setExhausted("decomposed_rejected");
              }}
            >
              {t("llm.notRight")}
            </button>
            <button
              type="button"
              className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
              onClick={reset}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : null}

      {/*
        The way out, after the attempt (D81).

        Only rendered once a decomposition has actually failed or been rejected,
        because that is a precondition of the estimate path rather than a
        decoration on it. The form carries what was typed, so the sentence does
        not have to be written twice.
      */}
      {exhausted !== null ? (
        <div className="panel mt-4" data-testid="estimate-fallback">
          <p className="max-w-prose text-micro text-muted">{t("llm.tryEstimate")}</p>
          <div className="mt-3">
            <EstimateEntry
              dish={text.trim()}
              after={exhausted}
              onCreated={() => {
                reset();
                setExhausted(null);
                onLogged(t("estimate.saved"));
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
