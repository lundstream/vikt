import { useState, type ChangeEvent } from "react";
import type { ReadRecipeResponse, RecipeRow } from "shared";
import { useReadRecipe } from "../lib/food.js";
import { preparePhoto } from "../lib/photo.js";
import { ParsedProposal, type ProposalItem, type ProposalRow } from "./ParsedProposal.js";
import { plural, t } from "../i18n/index.js";

type Read = Extract<ReadRecipeResponse, { available: true }>;

/** What the meal sheet takes from a recipe besides its rows. */
export type RecipeFacts = { title: string | null; yield: Read["yield"] };

/**
 * A recipe's ingredient list, photographed, into the meal being built (D195).
 *
 * The plate photo's transport and its bargain: the image is resized here,
 * sent, and dropped; the model copies the lines; the database prices them;
 * a person keeps or removes each row before any of it is added.
 *
 * **One question, asked once, and never answered by the model.** A book that
 * prints two amount sets gets a choice above the list, the first by default;
 * every row carries both from the server, so switching needs no second
 * request. The list is rebuilt for the other set, which is why it asks before
 * the rows are worked through rather than per row.
 */
export function RecipePhotoEntry({
  onRows,
}: {
  onRows: (rows: ProposalItem[], recipe: RecipeFacts) => Promise<void>;
}) {
  const read = useReadRecipe();
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<Read | null>(null);
  const [set, setSet] = useState(0);
  const [preparing, setPreparing] = useState(false);

  const working = preparing || read.isPending;

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setMessage(null);
    setResult(null);
    setSet(0);
    setPreparing(true);
    const prepared = await preparePhoto(file);
    setPreparing(false);

    if (!prepared.ok) {
      setMessage(prepared.reason === "too_large" ? t("photo.tooLarge") : t("photo.unreadable"));
      return;
    }

    const answer = await read.mutateAsync({ image: prepared.base64 });
    if (!answer.available) {
      setMessage(answer.reason === "rate_limited" ? t("photo.rateLimited") : t("photo.unavailableNow"));
      return;
    }
    if (answer.rows.length === 0) {
      setMessage(t("recipePhoto.nothingFound"));
      return;
    }
    setResult(answer);
  }

  return (
    <div data-testid="recipe-entry">
      <p className="mb-3 max-w-prose text-micro text-muted">{t("recipePhoto.intro")}</p>

      <label className="btn inline-flex w-auto cursor-pointer items-center px-4">
        {working ? t("photo.working") : t("recipePhoto.shutter")}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          data-testid="recipe-photo-input"
          aria-label={t("recipePhoto.shutter")}
          disabled={working}
          onChange={(event) => void chosen(event)}
        />
      </label>

      {working ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {t("photo.waiting")}
        </p>
      ) : null}

      {message ? (
        <p role="status" className="mt-2 max-w-prose text-micro text-muted">
          {message}
        </p>
      ) : null}

      {result ? (
        <div className="mt-4">
          {result.yield.printed ? (
            <p className="text-micro text-muted" data-testid="recipe-yield">
              {t("recipePhoto.yieldPrinted", { printed: result.yield.printed })}
            </p>
          ) : null}

          {result.twoSets ? (
            <fieldset className="mt-3" data-testid="recipe-sets">
              <legend className="text-note text-ink">{t("recipePhoto.twoSets")}</legend>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                {[t("recipePhoto.firstSet"), t("recipePhoto.secondSet")].map((label, index) => (
                  <label key={label} className="flex min-h-11 items-center gap-2 text-note text-ink">
                    <input
                      type="radio"
                      name="recipe-set"
                      className="check"
                      data-testid={`recipe-set-${index}`}
                      checked={set === index}
                      onChange={() => setSet(index)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <ParsedProposal
            key={set}
            items={result.rows.map((row) => proposalFor(row, set))}
            intro={t("recipePhoto.checkBeforeAdding")}
            saving={false}
            requireMatch
            confirmLabel={(count) => plural(count, "meals.addRowsOne", "meals.addRows")}
            onConfirm={async (rows) => {
              await onRows(rows, { title: result.title, yield: result.yield });
            }}
            onCancel={() => setResult(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A recipe row as the list shows it, for one amount set.
 *
 * The grams are the server's for that set, null when the page gives none that
 * the app can use (a range, no amount, a unit with no conversion), which the
 * list shows as "inte än". The printed line always travels with it.
 */
export function proposalFor(row: RecipeRow, set: number): ProposalRow {
  const chosen = row.sets[set] ?? row.sets[0]!;
  return {
    name: row.name,
    estimatedGrams: chosen.grams,
    portion: null,
    portionSource: chosen.grams === null ? "unknown" : "hint",
    confidence: 1,
    match: row.match === null ? null : { ...row.match, kcal: chosen.kcal },
    printed: row.line,
    check: row.check,
  };
}
