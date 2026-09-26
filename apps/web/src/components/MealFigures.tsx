import type { MealNutritionResponse } from "shared";
import { formatDecimal, formatKcal } from "shared";
import { t } from "../i18n/index.js";

const KEYS = ["protein", "carbs", "fat", "fiber"] as const;

const LABEL = {
  protein: "macro.protein",
  carbs: "macro.carbs",
  fat: "macro.fat",
  fiber: "macro.fiber",
} as const;

/** "1 portion", "4 portioner", "1,5 portioner": as many decimals as it has. */
export function formatPortions(portions: number): string {
  const decimals = Number.isInteger(portions) ? 0 : Number.isInteger(portions * 10) ? 1 : 2;
  const figure = formatDecimal(portions, { decimals });
  return portions === 1 ? t("meals.portionOne") : t("meals.portionMany", { count: figure });
}

/**
 * A meal's figures per portion, exactly as `mealNutrition` returned them
 * (D186, D55).
 *
 * The energy in Blåbär, because it is nutrition; "minst" and Sten on anything
 * the rows do not fully carry, with the share of the meal that carries it
 * beneath, the day card's wording pointed at a dish. A macro no row carries is
 * left out rather than printed as 0 (D44), and a meal with no priced row at all
 * says "inte än".
 */
export function MealFigures({
  figures,
  compact = false,
  testId,
}: {
  figures: MealNutritionResponse;
  /** One line, for a list row: the energy and the macros, no coverage line. */
  compact?: boolean;
  testId?: string;
}) {
  const known = KEYS.filter((key) => figures[key].grams !== null);
  const partial = known.filter((key) => !figures[key].complete);
  const percent = (key: (typeof KEYS)[number]) => Math.round(figures[key].coverage * 100);

  return (
    <div data-testid={testId}>
      <p className="num text-micro">
        {figures.kcal === null ? (
          <span className="text-muted">{t("stat.notYet")}</span>
        ) : (
          <span
            data-testid="meal-kcal"
            className={figures.kcalComplete ? "text-nutrition" : "figure-partial"}
          >
            {t(figures.kcalComplete ? "meals.perPortion" : "meals.perPortionAtLeast", {
              kcal: formatKcal(figures.kcal),
            })}
          </span>
        )}
      </p>

      {known.length > 0 ? (
        <p className="num text-micro text-muted" data-testid="meal-macros">
          {known.map((key, index) => {
            const total = figures[key];
            return (
              <span key={key}>
                {index > 0 ? ", " : ""}
                <span className={total.complete ? undefined : "figure-partial"}>
                  {t(total.complete ? "food.macroFigure" : "food.macroAtLeast", {
                    name: t(LABEL[key]),
                    amount: formatDecimal(total.grams ?? 0, { decimals: 0 }),
                  })}
                </span>
              </span>
            );
          })}
        </p>
      ) : null}

      {compact || partial.length === 0 ? null : (
        <p className="num text-micro text-muted" data-testid="meal-coverage">
          {t("meals.coverage", {
            list: partial.map((key) => `${t(LABEL[key]).toLowerCase()} ${percent(key)} %`).join(", "),
          })}
        </p>
      )}
    </div>
  );
}
