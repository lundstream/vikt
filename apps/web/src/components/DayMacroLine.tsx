import type { DayMacros } from "shared";
import { formatDecimal } from "shared";
import { t } from "../i18n/index.js";

const KEYS = ["protein", "carbs", "fat", "fiber"] as const;

const LABEL = {
  protein: "macro.protein",
  carbs: "macro.carbs",
  fat: "macro.fat",
  fiber: "macro.fiber",
} as const;

/**
 * The day's macros on Mat, under the day's kcal total (D55, addendum
 * 2026-09-15).
 *
 * Computed by `dayMacros`, the same function the dashboard's figures come from,
 * so the two screens cannot disagree about a day. A macro that no logged food
 * carries is left out rather than printed as 0 (D44). One carried by only part
 * of the day's energy says "minst" and is drawn in Sten, with the share of the
 * day that carries it on the line below: once when the partial macros agree,
 * and each by name when they do not.
 */
export function DayMacroLine({ day, dayWord }: { day: DayMacros; dayWord: string }) {
  const known = KEYS.filter((key) => day[key].grams !== null);
  if (known.length === 0) return null;

  const partial = known.filter((key) => !day[key].complete);
  const percent = (key: (typeof KEYS)[number]) => Math.round(day[key].coverage * 100);

  /**
   * One unnamed share only when it is true of everything on the line: every
   * macro shown is partial, at the same share. With fibre partial and protein
   * complete, "50 % av maten har uppgifter" would read as a statement about the
   * whole line, so the partial ones are named instead (the day card's rule).
   */
  const shared =
    partial.length === known.length && new Set(partial.map(percent)).size === 1;

  return (
    <>
      <p className="num mt-0.5 text-micro text-muted" data-testid="day-macros">
        {known.map((key, index) => {
          const total = day[key];
          const text = t(total.complete ? "food.macroFigure" : "food.macroAtLeast", {
            name: t(LABEL[key]),
            amount: formatDecimal(total.grams ?? 0, { decimals: 0 }),
          });
          return (
            <span key={key}>
              {index > 0 ? ", " : ""}
              <span
                data-testid={`day-macro-${key}`}
                className={total.complete ? undefined : "figure-partial"}
              >
                {text}
              </span>
            </span>
          );
        })}
      </p>

      {partial.length === 0 ? null : (
        <p className="num text-micro text-muted" data-testid="day-macros-coverage">
          {shared
            ? t("food.macroPartial", { percent: percent(partial[0]!), day: dayWord })
            : t("food.macroPartialEach", {
                list: partial.map((key) => `${t(LABEL[key]).toLowerCase()} ${percent(key)} %`).join(", "),
                day: dayWord,
              })}
        </p>
      )}
    </>
  );
}
