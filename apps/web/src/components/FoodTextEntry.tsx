import { useState, type FormEvent } from "react";
import type { FoodMatch } from "shared";
import { useConfirmParsedFood, useLlmHealth, useParseFood } from "../lib/food.js";
import { EstimateEntry } from "./EstimateEntry.js";
import { ParsedProposal } from "./ParsedProposal.js";
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
  }

  function reset() {
    setText("");
    setProposal(null);
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
        <ParsedProposal
          items={proposal}
          intro={t("llm.checkBeforeSaving")}
          saving={confirm.isPending}
          onConfirm={async (rows) => {
            await confirm.mutateAsync({ localDate, mealSlot: "snack", items: rows });
            onLogged(t("llm.logged", { count: rows.length }));
          }}
          onCancel={reset}
          onReject={() => {
            // Looking at the decomposition and saying no is D81's other
            // condition. Recorded here, where it actually happened.
            setProposal(null);
            setExhausted("decomposed_rejected");
          }}
        />
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
