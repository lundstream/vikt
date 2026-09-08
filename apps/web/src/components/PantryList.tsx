import { useState, type FormEvent } from "react";
import type { PantryStaple } from "shared";
import { formatDecimal } from "shared";
import { Disclosure } from "./Disclosure.js";
import {
  useAddStaple,
  useDeleteStaple,
  usePantry,
  useUpdateStaple,
} from "../lib/food.js";
import { t } from "../i18n/index.js";

/**
 * The cupboard: what the recipe generator may assume without being told
 * (§6 phase 8).
 *
 * Seeded with a real list rather than an empty box, because a feature whose
 * value depends on configuration nobody does has no value. The user prunes it.
 *
 * The split is the reason this is a table and not a comma-separated string.
 * **Negligible** staples may be assumed silently: salt, pepper, vinegar.
 * Everything else is assumed *available* but still appears in the recipe's
 * ingredient list with an amount and still produces a food entry when the
 * recipe is logged, because three tablespoons of oil is roughly 360 kcal and a
 * recipe that omits it feeds a silently low number into the series TDEE is
 * computed from.
 *
 * Which side a staple falls on is derived from the matched food item's energy,
 * not asked of the user. It is shown, and it can be overridden, so the
 * classification is visible rather than a hidden judgement, and the override is
 * a deliberate departure rather than a chore.
 */
export function PantryList() {
  const pantry = usePantry();
  const add = useAddStaple();
  const remove = useDeleteStaple();

  const [name, setName] = useState("");

  const staples = pantry.data ?? [];
  const counted = staples.filter((staple) => !staple.negligible).length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    await add.mutateAsync({ name: trimmed });
    setName("");
  }

  return (
    <Disclosure
      label={t("pantry.title")}
      summary={pantry.data ? String(staples.length) : undefined}
      testId="pantry"
    >
      <p className="mt-1 max-w-prose text-micro text-muted">{t("pantry.intro")}</p>

      {staples.length > 0 ? (
        <ul className="mt-3 divide-y divide-edge border-y border-edge">
          {staples.map((staple) => (
            <StapleRow
              key={staple.id}
              staple={staple}
              onDelete={() => void remove.mutateAsync(staple.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-note text-muted">{t("pantry.empty")}</p>
      )}

      {/*
        The count that matters, stated rather than left to be worked out by
        reading every row: how many of these will show up in an ingredient list
        and in the day's intake.
      */}
      {staples.length > 0 ? (
        <p className="mt-2 text-micro text-muted">{t("pantry.countedNote", { count: counted })}</p>
      ) : null}

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          id="pantry-add"
          className="field flex-1"
          placeholder={t("pantry.addPlaceholder")}
          aria-label={t("pantry.add")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="submit"
          data-testid="add-staple"
          className="shrink-0 rounded-lg border border-edge px-4 text-note text-ink disabled:opacity-50"
          disabled={name.trim().length === 0 || add.isPending}
        >
          {t("pantry.add")}
        </button>
      </form>
    </Disclosure>
  );
}

/**
 * One staple, with both of its controls on the row that displays it (§3, D56).
 *
 * The classification toggle is the "edit": it is the only field that changes
 * anything downstream, and renaming a staple is the same as deleting it and
 * adding the other one.
 */
function StapleRow({ staple, onDelete }: { staple: PantryStaple; onDelete: () => void }) {
  const update = useUpdateStaple();
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <span className="min-w-0">
        <span className="block truncate text-note text-ink">{staple.name}</span>
        <span className="num block text-micro text-muted">
          {staple.negligible
            ? t("pantry.negligible")
            : staple.kcalPer100 === null
              ? t("pantry.counted")
              : t("pantry.countedAt", {
                  kcal: formatDecimal(staple.kcalPer100, { decimals: 0 }),
                })}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          data-testid={`toggle-staple-${staple.id}`}
          className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
          onClick={() =>
            void update.mutateAsync({ id: staple.id, negligible: !staple.negligible })
          }
          disabled={update.isPending}
        >
          {staple.negligible ? t("pantry.makeCounted") : t("pantry.makeNegligible")}
        </button>

        {/* Two taps, like every other delete in the app. */}
        {confirming ? (
          <button
            type="button"
            data-testid={`confirm-delete-staple-${staple.id}`}
            className="min-h-11 px-1 text-micro text-ink underline underline-offset-4"
            onClick={onDelete}
          >
            {t("delete.confirm")}
          </button>
        ) : (
          <button
            type="button"
            data-testid={`delete-staple-${staple.id}`}
            className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
            onClick={() => setConfirming(true)}
          >
            {t("delete.action")}
          </button>
        )}
      </span>
    </li>
  );
}
