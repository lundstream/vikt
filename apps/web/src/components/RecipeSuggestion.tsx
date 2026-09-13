import { useEffect, useState, type FormEvent } from "react";
import type { FoodMatch, RecipeBudget, RecipeTotal } from "shared";
import { formatDecimal, formatKcal, formatPortion } from "shared";
import { fieldAria } from "./Field.js";
import { PantryList } from "./PantryList.js";
import { SavedRecipes } from "./SavedRecipes.js";
import {
  useConfirmParsedFood,
  useGenerateRecipe,
  useLlmHealth,
  useSaveRecipe,
} from "../lib/food.js";
import { clientUuid } from "../lib/uuid.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { plural, t } from "../i18n/index.js";

type Generated = {
  title: string;
  steps: string[];
  items: FoodMatch[];
  budget: RecipeBudget;
  total: RecipeTotal;
};

/**
 * A recipe from what is in the fridge, inside what is left of the day
 * (§6 phase 8).
 *
 * The rules it keeps, each a decision rather than a preference.
 *
 * **It is not here when the layer is not.** The workstation is not always on
 * and nothing may depend on it, so this renders nothing at all unless the
 * health check says the host answered. Not a disabled control and not a message
 * about unavailability: **no error banner** is the brief's phrase, and the
 * fullest way to honour it is for the screen to look as it did before.
 *
 * **Every calorie came out of `food_items`.** The model contributes a title,
 * steps and named amounts; the server matches and prices them through the same
 * path a typed sentence goes through.
 *
 * **An incomplete total is not a total** (D74). What is missing is named at the
 * same size as the number, and the recipe cannot be logged until every unpriced
 * row has been given a value or marked as nothing.
 *
 * **Portions where the kitchen has them, grams where it does not.** "1 citron"
 * is an instruction; "citron 50 g" is a weighing task nobody performs. The
 * grams are still there, still editable, and still what gets stored.
 *
 * **A recipe is a proposal to cook, not a record of eating.** Generating one
 * logs nothing. Cooking it and logging it is a separate, later press, with the
 * portions still editable, because the model cooked for one and nobody's pan
 * agrees with it exactly.
 */
export function RecipeSuggestion({
  localDate,
  onLogged,
}: {
  localDate: string;
  onLogged: (message: string) => void;
}) {
  const health = useLlmHealth();
  const generate = useGenerateRecipe();
  const confirm = useConfirmParsedFood();
  const saveRecipe = useSaveRecipe();

  const [have, setHave] = useState("");
  const [recipe, setRecipe] = useState<Generated | null>(null);
  const [grams, setGrams] = useState<Record<number, string>>({});
  /** What the user says an unpriced ingredient is worth (D74). */
  const [kcals, setKcals] = useState<Record<number, string>>({});
  const [note, setNote] = useState<string | null>(null);

  /** `reachable`, not `configured`: a configured box that is off is the case. */
  if (!health.data?.reachable) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    await run();
  }

  async function run() {
    setNote(null);
    setRecipe(null);

    const result = await generate.mutateAsync({ localDate, have: have.trim() });

    if (!result.available) {
      /**
       * Two failures told apart, because they mean different things to the
       * person reading. `incomplete_recipe` is the model having produced
       * something unusable twice and is worth saying plainly; everything else
       * is the layer being unavailable, which is not an error.
       */
      setNote(
        result.reason === "incomplete_recipe"
          ? t("recipe.incomplete")
          : t("recipe.unavailableNow"),
      );
      return;
    }

    setRecipe(result);
    setGrams(
      Object.fromEntries(
        result.items.map((item, index) => [
          index,
          // Null is the photo path's "nobody knows yet" (D143): an empty
          // field, never a number nobody stated.
          item.estimatedGrams === null
            ? ""
            : formatDecimal(item.estimatedGrams, { decimals: 0 }),
        ]),
      ),
    );
    setKcals({});
  }

  /** The rows as they stand, or null and a note naming the first one that is not ready. */
  function readRows() {
    if (!recipe) return null;

    const rows = [];
    for (const [index, item] of recipe.items.entries()) {
      const amount = readRequiredNumber(grams[index] ?? "");
      if (!amount.ok) {
        setNote(amount.message);
        return null;
      }

      let kcal: number | null = null;
      if (item.match === null) {
        const value = readRequiredNumber(kcals[index] ?? "");
        if (!value.ok) {
          setNote(t("llm.needsValue", { name: item.name }));
          return null;
        }
        kcal = value.value;
      }

      rows.push({
        name: item.match?.name ?? item.name,
        foodItemId: item.match?.foodItemId ?? null,
        grams: amount.value,
        portion: item.portion,
        kcal,
      });
    }

    return rows;
  }

  async function log() {
    const rows = readRows();
    if (!rows || !recipe) return;

    await confirm.mutateAsync({
      localDate,
      mealSlot: "snack",
      items: rows.map((row) => ({
        clientUuid: clientUuid(),
        foodItemId: row.foodItemId,
        name: row.name,
        grams: row.grams,
        ...(row.kcal === null ? {} : { kcal: row.kcal }),
      })),
    });

    setRecipe(null);
    setHave("");
    onLogged(plural(rows.length, "recipe.loggedOne", "recipe.logged"));
  }

  /**
   * Keeping it, with the text frozen as generated (§6).
   *
   * Separate from logging on purpose: saving is "I want to cook this again",
   * logging is "I ate it", and they happen at different moments and often only
   * one of them happens at all.
   */
  async function keep() {
    const rows = readRows();
    if (!rows || !recipe) return;

    await saveRecipe.mutateAsync({
      title: recipe.title,
      steps: recipe.steps,
      items: rows.map((row) => ({
        name: row.name,
        grams: row.grams,
        foodItemId: row.foodItemId,
        portion: row.portion,
      })),
      createTemplate: true,
    });

    setNote(t("recipe.kept"));
  }

  return (
    <div>
      <p className="max-w-prose text-micro text-muted">{t("recipe.intro")}</p>

      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          id="recipe-have"
          className="field flex-1"
          placeholder={t("recipe.placeholder")}
          aria-label={t("recipe.have")}
          value={have}
          onChange={(event) => setHave(event.target.value)}
          disabled={generate.isPending}
        />
        <button
          type="submit"
          data-testid="generate-recipe"
          className="btn w-auto  disabled:opacity-50"
          disabled={have.trim().length < 2 || generate.isPending}
        >
          {generate.isPending ? t("recipe.thinking") : t("recipe.generate")}
        </button>
      </form>

      {generate.isPending ? <Elapsed /> : null}

      {note ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {note}
        </p>
      ) : null}

      {recipe ? (
        <div className="panel mt-4" data-testid="recipe-result">
          {/*
            The constraint first, then the dish. Reading the recipe before
            knowing what it was fitted into makes the fit invisible, and the fit
            is the only reason to ask a machine rather than a cookbook.
          */}
          <p className="text-micro text-muted">{budgetLine(recipe.budget)}</p>

          <h3 className="mt-2 text-lg text-ink">{recipe.title}</h3>

          <ol className="mt-3 list-decimal space-y-2 pl-5 text-note text-ink marker:text-muted">
            {recipe.steps.map((step, index) => (
              <li key={index} className="max-w-prose">
                {step}
              </li>
            ))}
          </ol>

          <ul className="mt-4 space-y-3 border-t border-edge pt-4">
            {recipe.items.map((item, index) => (
              <li
                key={`${item.name}-${index}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2"
              >
                <span className="min-w-0">
                  {/*
                    The portion leads where there is one, because that is the
                    line someone reads at a chopping board. "1 citron", not
                    "citron 50 g".
                  */}
                  <span className="block truncate text-note text-ink">
                    {item.portion ? `${formatPortion(item.portion)} ` : ""}
                    {item.match?.name ?? item.name}
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
                    className="field num pr-7 text-right"
                    type="text"
                    inputMode="decimal"
                    aria-label={t("food.grams")}
                    value={grams[index] ?? ""}
                    onChange={(event) =>
                      setGrams((current) => ({ ...current, [index]: event.target.value }))
                    }
                    {...fieldAria(`recipe-grams-${index}`, undefined)}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-micro text-muted"
                  >
                    g
                  </span>
                </span>

                {/*
                  An ingredient the database could not price. Two ways to give
                  it a value, because both are real answers: type what it was
                  worth, or say it was nothing, which is what a pinch of salt
                  actually is. Until one of them is done, the recipe does not
                  log (D74).
                */}
                {item.match === null ? (
                  <span className="col-span-2 flex items-center gap-2">
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
                        {...fieldAria(`recipe-kcal-${index}`, undefined)}
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
                      data-testid={`recipe-negligible-${index}`}
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

          {/*
            The total, and whether it is the whole of it (D74).

            The version this replaced showed the sum as a headline figure with
            "1 råvara saknas i summan" in small grey text underneath: a number
            that looks like an answer, is understated, and carries its own
            correction in the size the eye skips. What is missing is now named
            at the same weight as the figure, and the figure says "minst".
          */}
          <div className="mt-4 border-t border-edge pt-3">
            {/*
              An incomplete total is dimmed rather than recoloured (profile,
              page 6). It is still the same kind of number; there is just less
              of it known, and "minst" is what says so.
            */}
            <p
              className={`num text-note ${
                recipe.total.complete ? "text-ink" : "figure-partial"
              }`}
            >
              {recipe.total.kcal === null
                ? t("recipe.noTotal")
                : recipe.total.complete
                  ? t("recipe.total", { kcal: formatKcal(recipe.total.kcal) })
                  : t("recipe.totalAtLeast", { kcal: formatKcal(recipe.total.kcal) })}
            </p>
            {recipe.total.missing.length > 0 ? (
              <p className="mt-1 max-w-prose text-note text-ink">
                {t("recipe.missingNamed", { names: recipe.total.missing.join(", ") })}
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              data-testid="log-recipe"
              className="btn w-auto px-4"
              onClick={() => void log()}
              disabled={confirm.isPending}
            >
              {t("recipe.log")}
            </button>
            <button
              type="button"
              data-testid="keep-recipe"
              className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
              onClick={() => void keep()}
              disabled={saveRecipe.isPending}
            >
              {t("recipe.keep")}
            </button>
            <button
              type="button"
              className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
              onClick={() => void run()}
              disabled={generate.isPending}
            >
              {t("recipe.again")}
            </button>
          </div>
        </div>
      ) : null}

      {/*
        The two lists that belong to this surface and nowhere else: what has
        been cooked before, and what is assumed to be in the cupboard. Folded,
        because they are reference material rather than the point, and here
        rather than in settings because this is where their rows are displayed
        and therefore where edit and delete belong (§3).
      */}
      <div className="mt-8 space-y-2 border-t border-edge pt-4">
        <SavedRecipes localDate={localDate} onLogged={onLogged} />
        <PantryList />
      </div>
    </div>
  );
}

/**
 * What the model was told was left of the day.
 *
 * Four sentences for four states, because they are four different claims. A
 * plan gives a figure; a partly labelled day gives an upper bound and has to
 * say "at most" (D55); a day already at its target has no room and says so
 * without scolding; no plan gives nothing at all, and the honest phrasing is
 * that there was no budget, not "0 kcal left", which would be a limit the app
 * invented.
 */
function budgetLine(budget: RecipeBudget): string {
  if (budget.kcal === null) return t("recipe.noBudget");

  /**
   * Clamped at zero upstream, so zero means the day's target is behind us
   * rather than exactly met. "Högst 0 kcal" is both unusable as a constraint
   * and, on a screen someone opens while hungry, a scolding, which §3 rules
   * out. It says what the suggestion is instead.
   */
  if (budget.kcal < 1) return t("recipe.budgetReached");

  const kcal = formatKcal(budget.kcal);
  const protein =
    budget.proteinG === null ? null : formatDecimal(budget.proteinG, { decimals: 0 });

  if (protein === null) {
    return budget.approximate
      ? t("recipe.budgetAtMost", { kcal })
      : t("recipe.budget", { kcal });
  }

  return budget.approximate
    ? t("recipe.budgetProteinAtMost", { kcal, protein })
    : t("recipe.budgetProtein", { kcal, protein });
}

/**
 * A running second count while the model works.
 *
 * The one place in this app where a wait is long enough that a spinner reads as
 * a hang. Half a minute from cold is not a failure, and a number that keeps
 * moving is the difference between waiting and giving up.
 */
function Elapsed() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <p role="status" className="num mt-2 text-micro text-muted">
      {t("recipe.elapsed", { seconds: String(seconds) })}
    </p>
  );
}
