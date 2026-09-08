import { useState } from "react";
import type { SavedRecipe } from "shared";
import { formatDecimal, formatPortion } from "shared";
import { Disclosure } from "./Disclosure.js";
import {
  useApplyTemplate,
  useDeleteRecipe,
  useSavedRecipes,
  useUpdateRecipe,
} from "../lib/food.js";
import { clientUuid } from "../lib/uuid.js";
import { plural, t } from "../i18n/index.js";

/**
 * Recipes that have been kept: how a dish was cooked (§6 phase 8).
 *
 * Deliberately not the same thing as a saved meal. A meal template is "log
 * these rows again in one tap"; a recipe is "how did I cook that". They link,
 * so cooking it again is one tap on the template the recipe generated, and
 * reading how is one tap more here.
 *
 * The three rules §6 sets for storing model-generated prose:
 *
 *  - **the text is frozen when saved.** Regenerating the same dish produces
 *    different words, and a saved recipe that rewrote itself would be a record
 *    of something that never happened;
 *  - **it is editable.** The corrections to timings, amounts and method are the
 *    entire value of keeping it, and the first thing anyone does after cooking
 *    is discover the model's fifteen minutes was twenty-five;
 *  - **the nutrition still comes from the database**, which it does: the items
 *    were priced at generation and the template holds the rows.
 */
export function SavedRecipes({
  localDate,
  onLogged,
}: {
  localDate: string;
  onLogged: (message: string) => void;
}) {
  const recipes = useSavedRecipes();
  const list = recipes.data ?? [];

  return (
    <Disclosure
      label={t("recipe.saved")}
      summary={recipes.data ? String(list.length) : undefined}
      testId="saved-recipes"
    >
      {list.length === 0 ? (
        <p className="mt-2 max-w-prose text-note text-muted">{t("recipe.noneSaved")}</p>
      ) : (
        <ul className="mt-2 divide-y divide-edge border-y border-edge">
          {list.map((recipe) => (
            <RecipeRow
              key={recipe.id}
              recipe={recipe}
              localDate={localDate}
              onLogged={onLogged}
            />
          ))}
        </ul>
      )}
    </Disclosure>
  );
}

function RecipeRow({
  recipe,
  localDate,
  onLogged,
}: {
  recipe: SavedRecipe;
  localDate: string;
  onLogged: (message: string) => void;
}) {
  const apply = useApplyTemplate();
  const update = useUpdateRecipe();
  const remove = useDeleteRecipe();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [steps, setSteps] = useState(recipe.steps.join("\n"));
  const [confirming, setConfirming] = useState(false);

  /** Cooking it again: the template the recipe generated, through the phase 3 path. */
  async function cook() {
    if (!recipe.templateId) return;
    await apply.mutateAsync({
      templateId: recipe.templateId,
      input: { localDate, clientUuids: recipe.items.map(() => clientUuid()) },
    });
    onLogged(plural(recipe.items.length, "recipe.loggedOne", "recipe.logged"));
  }

  async function saveEdit() {
    const lines = steps
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;

    await update.mutateAsync({ id: recipe.id, steps: lines });
    setEditing(false);
  }

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          data-testid={`open-recipe-${recipe.id}`}
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
        >
          <span className="block truncate text-note text-ink">{recipe.title}</span>
          <span className="num block text-micro text-muted">
            {plural(recipe.items.length, "recipe.itemCountOne", "recipe.itemCount")}
          </span>
        </button>

        {/*
          One tap to cook it again, which is what the template is for. Absent
          when nothing in the recipe could be priced, because a template of
          unpriced rows would write a zero-energy meal every time (D74).
        */}
        {recipe.templateId ? (
          <button
            type="button"
            data-testid={`cook-recipe-${recipe.id}`}
            className="shrink-0 text-note text-muted underline underline-offset-4"
            onClick={() => void cook()}
            disabled={apply.isPending}
          >
            {t("recipe.cookAgain")}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="mt-3 border-l border-edge pl-3">
          <ul className="num space-y-1 text-micro text-muted">
            {recipe.items.map((item, index) => (
              <li key={index}>
                {item.portion
                  ? `${formatPortion(item.portion)} ${item.name}`
                  : `${item.name}, ${formatDecimal(item.grams, { decimals: 0 })} g`}
              </li>
            ))}
          </ul>

          {editing ? (
            <div className="mt-3">
              <textarea
                className="field min-h-32 w-full"
                aria-label={t("recipe.steps")}
                value={steps}
                onChange={(event) => setSteps(event.target.value)}
              />
              <p className="mt-1 text-micro text-muted">{t("recipe.stepsHint")}</p>
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  data-testid={`save-recipe-${recipe.id}`}
                  className="min-h-11 px-1 text-note text-ink underline underline-offset-4"
                  onClick={() => void saveEdit()}
                  disabled={update.isPending}
                >
                  {t("quick.save")}
                </button>
                <button
                  type="button"
                  className="min-h-11 px-1 text-note text-muted underline underline-offset-4"
                  onClick={() => {
                    setSteps(recipe.steps.join("\n"));
                    setEditing(false);
                  }}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-note text-ink marker:text-muted">
                {recipe.steps.map((step, index) => (
                  <li key={index} className="max-w-prose">
                    {step}
                  </li>
                ))}
              </ol>

              {/* Edit and delete, on the screen that displays the row (§3). */}
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  data-testid={`edit-recipe-${recipe.id}`}
                  className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
                  onClick={() => setEditing(true)}
                >
                  {t("common.edit")}
                </button>

                {confirming ? (
                  <button
                    type="button"
                    data-testid={`confirm-delete-recipe-${recipe.id}`}
                    className="min-h-11 px-1 text-micro text-ink underline underline-offset-4"
                    onClick={() => void remove.mutateAsync(recipe.id)}
                  >
                    {t("delete.confirm")}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`delete-recipe-${recipe.id}`}
                    className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
                    onClick={() => setConfirming(true)}
                  >
                    {t("delete.action")}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}
