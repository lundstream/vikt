import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import type { Meal } from "shared";
import { useMe } from "../lib/session.js";
import { useLlmHealth, useMeals } from "../lib/food.js";
import { useLogDate } from "../lib/log-date.js";
import { MealFigures, formatPortions } from "../components/MealFigures.js";
import { MealSheet } from "../components/MealSheet.js";
import { RecipeSuggestion } from "../components/RecipeSuggestion.js";
import { Sheet } from "../components/Sheet.js";
import { ActionButton, newMealIcon, potIcon, type QuickAction } from "../components/QuickActions.js";
import { t } from "../i18n/index.js";

/**
 * Måltider (Phase 14, D187): the person's own dishes, per portion.
 *
 * Reached from Mer and from the top of Mat rather than being a fifth tab. It
 * is where a meal is made and changed; logging one is the row on Mat, which is
 * where somebody is when they ate it.
 *
 * **"Vad kan jag laga" lives here now**, unchanged in behaviour. It is a way
 * of arriving at a dish, which is what this section holds, and on Mat it was
 * one of five doors on a screen whose job is the next thing eaten. A
 * suggestion kept is a meal in this list, from one tap.
 */
export function Meals() {
  const me = useMe();
  const meals = useMeals();
  const llm = useLlmHealth();
  const { date: today } = useLogDate();

  const [sheet, setSheet] = useState<{ meal: Meal | null } | null>(null);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  if (me.isPending) return null;
  if (!me.data) return <Navigate to="/login" replace />;

  function announce(message: string) {
    if (message === "") return;
    setFlash(message);
    setTimeout(() => setFlash(null), 2400);
  }

  const ways: QuickAction[] = [
    {
      key: "new",
      label: "meals.new",
      icon: newMealIcon,
      onClick: () => setSheet({ meal: null }),
      testId: "meal-new",
    },
    ...(llm.data?.reachable
      ? ([
          {
            key: "recipe",
            label: "recipe.title",
            icon: potIcon,
            onClick: () => setRecipeOpen(true),
            testId: "open-recipe",
          },
        ] satisfies QuickAction[])
      : []),
  ];

  return (
    <div className="min-h-dvh pb-28">
      <main className="mx-auto w-full max-w-3xl px-5 py-8">
        <header className="mb-6 flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-title text-ink">{t("meals.title")}</h1>
            <p className="mt-1 max-w-prose text-note text-muted">{t("meals.intro")}</p>
          </div>
          <Link className="text-note text-muted underline underline-offset-4" to="/food">
            {t("meals.toFood")}
          </Link>
        </header>

        {flash ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-edge bg-edge/20 px-3 py-2 text-note text-ink"
          >
            {flash}
          </p>
        ) : null}

        <nav aria-label={t("meals.ways")} className="mb-8">
          <ul className="flex flex-wrap items-start justify-center gap-x-4 gap-y-4 sm:gap-x-8">
            {ways.map((action) => (
              <li key={action.key}>
                <ActionButton action={action} />
              </li>
            ))}
          </ul>
        </nav>

        <section aria-labelledby="meals-yours">
          <h2 id="meals-yours" className="mb-1 text-note text-muted">
            {t("meals.yours")}
          </h2>
          {meals.data === undefined ? null : meals.data.length === 0 ? (
            <p className="max-w-prose border-y border-edge py-4 text-note text-muted">
              {t("meals.empty")}
            </p>
          ) : (
            <ul className="divide-y divide-edge border-y border-edge" data-testid="meal-list">
              {meals.data.map((meal) => (
                <li key={meal.id}>
                  <button
                    type="button"
                    data-testid={`meal-open-${meal.id}`}
                    className="flex w-full items-start gap-3 py-3 text-left"
                    onClick={() => setSheet({ meal })}
                  >
                    {meal.photoUrl ? (
                      <img
                        src={meal.photoUrl}
                        alt=""
                        className="size-14 shrink-0 rounded-lg object-cover"
                        loading="lazy"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-ink">{meal.name}</span>
                      <span className="num block text-micro text-muted">
                        {formatPortions(meal.portions)}
                        {" · "}
                        {meal.items.length === 1
                          ? t("food.itemOne")
                          : t("food.itemMany", { count: meal.items.length })}
                      </span>
                      <MealFigures figures={meal.perPortion} compact />
                    </span>
                    <span aria-hidden="true" className="shrink-0 self-center text-muted">
                      ›
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        title={sheet?.meal ? t("meals.sheetEdit") : t("meals.sheetNew")}
        testId="meal-sheet-dialog"
      >
        {sheet ? (
          <MealSheet
            key={sheet.meal?.id ?? "new"}
            {...(sheet.meal ? { meal: sheet.meal } : {})}
            onDone={(message) => {
              setSheet(null);
              announce(message);
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={recipeOpen}
        onClose={() => setRecipeOpen(false)}
        title={t("recipe.title")}
        testId="recipe-sheet"
      >
        {/*
          Not closed on logging: a recipe is read while cooking, and closing it
          the moment the food is logged takes the instructions away while they
          are still being followed.
        */}
        <RecipeSuggestion localDate={today} onLogged={announce} />
      </Sheet>
    </div>
  );
}
