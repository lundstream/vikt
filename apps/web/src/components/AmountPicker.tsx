import { useState } from "react";
import type { FoodItem } from "shared";
import { allPortionUnits, formatDecimal, formatKcal, resolveDefaultAmount } from "shared";
import { usePortions } from "../lib/food.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { Field, fieldAria } from "./Field.js";
import { FoodTags } from "./FoodTags.js";
import { t } from "../i18n/index.js";

/** What an ingredient row came to: what was measured, and what it weighs. */
export type PickedAmount = { amount: number; unit: string; grams: number };

/**
 * An amount of one food, in grams or in any unit the food can be counted in
 * (D186).
 *
 * The portion sheet on Mat stores grams and treats a unit as a shortcut for
 * filling them in. A meal's ingredient row keeps both, because "2 dl" is what
 * the person measured and what they will look for when they read the recipe
 * back, and the grams are what the arithmetic uses. So here the unit is chosen
 * and the amount counts it, and the grams it comes to are shown beside it
 * before anything is added.
 *
 * The units are the same three layers the portion sheet offers (D85): the
 * person's own, the packet's, and the household table.
 */
export function AmountPicker({
  item,
  onPick,
  onCancel,
  confirmLabel,
}: {
  item: FoodItem;
  onPick: (picked: PickedAmount) => void;
  onCancel: () => void;
  confirmLabel: string;
}) {
  const portions = usePortions();
  const own = portions.data?.filter((portion) => portion.foodItemId === item.id) ?? [];
  const userHints = Object.fromEntries(own.map((portion) => [portion.unit, portion.grams]));
  const units = [
    { unit: "g", grams: 1 },
    ...allPortionUnits({ userHints, sourceHints: item.servingHints, category: item.category }),
  ];

  const suggested = resolveDefaultAmount({
    lastGrams: item.lastGrams,
    userHints,
    sourceHints: item.servingHints,
    category: item.category,
  });
  const startUnit = units.find((unit) => unit.unit === suggested.unit) ?? units[0]!;
  const [unit, setUnit] = useState(startUnit.unit);
  const [amount, setAmount] = useState(
    startUnit.unit === "g" ? formatDecimal(suggested.grams, { decimals: 0 }) : "1",
  );
  const [error, setError] = useState<string | null>(null);

  const perUnit = units.find((candidate) => candidate.unit === unit)?.grams ?? 1;
  const parsed = readRequiredNumber(amount);
  const grams = parsed.ok ? parsed.value * perUnit : null;

  function add() {
    if (!parsed.ok || grams === null || grams <= 0) {
      setError(parsed.ok ? t("meals.amountPositive") : parsed.message);
      return;
    }
    onPick({ amount: parsed.value, unit, grams: Math.round(grams * 10) / 10 });
  }

  return (
    <div className="panel mt-3" data-testid="amount-picker">
      <p className="text-note text-ink">{item.name}</p>
      <p className="num text-micro text-muted">
        {item.brand ? `${item.brand} · ` : ""}
        {formatDecimal(item.kcalPer100, { decimals: 0 })} kcal / 100 g
        <FoodTags item={item} />
      </p>

      <div className="mt-3">
        <Field id="meal-amount" label={t("meals.amount")} error={error ?? undefined}>
          <input
            id="meal-amount"
            className="field num"
            type="text"
            inputMode="decimal"
            autoFocus
            {...fieldAria("meal-amount", error ?? undefined)}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={t("meals.unit")}>
        {units.map((candidate) => (
          <button
            key={candidate.unit}
            type="button"
            data-testid={`meal-unit-${candidate.unit}`}
            aria-pressed={unit === candidate.unit}
            className="chip"
            onClick={() => setUnit(candidate.unit)}
          >
            {candidate.unit === "g"
              ? t("meals.unitGrams")
              : t("portion.oneIs", {
                  unit: candidate.unit,
                  grams: formatDecimal(candidate.grams, { decimals: 0 }),
                })}
          </button>
        ))}
      </div>

      <p className="num mt-2 text-micro text-muted" data-testid="amount-grams">
        {grams === null
          ? t("stat.notYet")
          : t("meals.comesTo", {
              grams: formatDecimal(grams, { decimals: 0 }),
              kcal: formatKcal((item.kcalPer100 * grams) / 100),
            })}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" data-testid="amount-add" className="btn w-auto px-4" onClick={add}>
          {confirmLabel}
        </button>
        <button type="button" className="btn-link" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
