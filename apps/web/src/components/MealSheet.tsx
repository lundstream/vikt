import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { FoodItem, Meal, MealRowFood } from "shared";
import { MIN_SEARCH_LENGTH, formatDecimal, formatKcal, mealNutrition } from "shared";
import {
  useBarcodeLookup,
  useCreateMeal,
  useDeleteMeal,
  useFoodSearch,
  useDeleteMealPhoto,
  useLlmHealth,
  useShareMeal,
  useSetMealPhoto,
  useUpdateMeal,
} from "../lib/food.js";
import { preparePhoto } from "../lib/photo.js";
import { useMe } from "../lib/session.js";
import { formatLongDay } from "../lib/dates.js";
import { LOCALE, plural } from "../i18n/index.js";
import { api, ApiError } from "../lib/api.js";
import { useOnline } from "../lib/queue/useQueue.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { clientUuid } from "../lib/uuid.js";
import { AmountPicker, type PickedAmount } from "./AmountPicker.js";
import { BarcodeScanner } from "./BarcodeScanner.js";
import { DeleteButton } from "./DeleteButton.js";
import { Field, fieldAria } from "./Field.js";
import { FoodPhotoEntry } from "./FoodPhotoEntry.js";
import { FoodTextEntry } from "./FoodTextEntry.js";
import { RecipePhotoEntry, type RecipeFacts } from "./RecipePhotoEntry.js";
import { FoodTags } from "./FoodTags.js";
import { MealFigures } from "./MealFigures.js";
import type { ProposalItem } from "./ParsedProposal.js";
import { SearchStatus } from "./SearchStatus.js";
import {
  ActionButton,
  barcodeIcon,
  cameraIcon,
  recipeIcon,
  searchIcon,
  speechIcon,
  type QuickAction,
} from "./QuickActions.js";
import { t } from "../i18n/index.js";

/** One ingredient row while the sheet is open. `food` null: the food is gone. */
type Row = {
  key: string;
  foodItemId: string | null;
  name: string;
  amount: number;
  unit: string;
  grams: number;
  food: MealRowFood | null;
  isEstimate: boolean;
};

function priceOf(item: FoodItem): MealRowFood {
  return {
    kcalPer100: item.kcalPer100,
    proteinPer100: item.proteinPer100,
    carbsPer100: item.carbsPer100,
    fatPer100: item.fatPer100,
    fiberPer100: item.fiberPer100,
  };
}

function rowsOf(meal: Meal | undefined): Row[] {
  return (meal?.items ?? []).map((item) => ({
    key: item.id,
    foodItemId: item.foodItemId,
    name: item.name,
    amount: item.amount,
    unit: item.unit,
    grams: item.grams,
    food: item.food,
    isEstimate: item.food?.isEstimate ?? false,
  }));
}

/**
 * Creating and editing a meal (Phase 14, D186).
 *
 * The rows are built with the tools Mat already has, in the same shape and in
 * the same order: search, barcode, a sentence, a photograph of a plate. What
 * differs is where a chosen food goes. On Mat it is logged; here it is sized
 * in an amount and a unit and added to the list, and nothing is written until
 * the meal is saved.
 *
 * **The figure under the portions is the one the list will show**, because it
 * is `mealNutrition` from the shared calc run on the rows as they stand, which
 * is what the server runs on them once they are saved. A row whose food has
 * gone since the meal was made keeps its name and prices as unknown, and the
 * figure says "minst" until it is removed or replaced.
 *
 * Edit and remove are here from the first version (§3, D56), and removing the
 * meal leaves every day it was logged on exactly as it was.
 */
export function MealSheet({
  meal,
  onDone,
}: {
  /** The meal being edited, or nothing for a new one. */
  meal?: Meal;
  onDone: (message: string) => void;
}) {
  const create = useCreateMeal();
  const update = useUpdateMeal();
  const remove = useDeleteMeal();
  const llm = useLlmHealth();
  const online = useOnline();
  const lookup = useBarcodeLookup();
  const setPhoto = useSetMealPhoto();
  const deletePhoto = useDeleteMealPhoto();
  const me = useMe();
  const shareMeal = useShareMeal();
  const publicName = me.data?.profile.publicName?.trim() ?? "";
  const [sharedAt, setSharedAt] = useState<string | null>(meal?.sharedAt ?? null);
  const [mayShare, setMayShare] = useState(false);

  /**
   * The photo (D191): the saved one's URL, or a picture chosen for a meal not
   * saved yet, held in memory until the create returns an id to put it on.
   */
  const [photoUrl, setPhotoUrl] = useState<string | null>(meal?.photoUrl ?? null);
  const [pendingPhoto, setPendingPhoto] = useState<{ base64: string; preview: string } | null>(null);
  const [photoWorking, setPhotoWorking] = useState(false);
  useEffect(
    () => () => {
      if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.preview);
    },
    [pendingPhoto],
  );

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    setPhotoWorking(true);
    const prepared = await preparePhoto(file);
    if (!prepared.ok) {
      setPhotoWorking(false);
      setError(prepared.reason === "too_large" ? t("photo.tooLarge") : t("photo.unreadable"));
      return;
    }
    try {
      if (meal) {
        const saved = await setPhoto.mutateAsync({ mealId: meal.id, image: prepared.base64 });
        setPhotoUrl(saved.photoUrl);
      } else {
        setPendingPhoto({ base64: prepared.base64, preview: URL.createObjectURL(prepared.blob) });
      }
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : t("save.failed"));
    } finally {
      setPhotoWorking(false);
    }
  }

  const [name, setName] = useState(meal?.name ?? "");
  const [portions, setPortions] = useState(
    formatDecimal(meal?.portions ?? 1, { decimals: Number.isInteger(meal?.portions ?? 1) ? 0 : 2 }),
  );
  const [rows, setRows] = useState<Row[]>(() => rowsOf(meal));
  const [tool, setTool] = useState<"search" | "text" | "photo" | "recipe" | null>(null);
  /** A recipe's yield that is not a number of portions, shown beside the field (D195). */
  const [yieldNote, setYieldNote] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picking, setPicking] = useState<FoodItem | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState("");
  const [searchEnabled, setSearchEnabled] = useState(false);
  const search = useFoodSearch(query, searchEnabled);

  const portionCount = readRequiredNumber(portions);
  /** The divisor the running figure uses: one until a count has been typed. */
  const divisor = portionCount.ok && portionCount.value > 0 ? portionCount.value : 1;
  const figures = useMemo(
    () => mealNutrition(rows.map((row) => ({ grams: row.grams, food: row.food })), divisor),
    [rows, divisor],
  );

  const ways: QuickAction[] = [
    {
      key: "search",
      label: "meals.search",
      icon: searchIcon,
      onClick: () => setTool(tool === "search" ? null : "search"),
      testId: "meal-tool-search",
    },
    {
      key: "scan",
      label: "action.scan",
      icon: barcodeIcon,
      onClick: () => {
        setTool(null);
        setScanning(true);
      },
      testId: "meal-tool-scan",
    },
    ...(llm.data?.reachable
      ? ([
          {
            key: "text",
            label: "meals.sentence",
            icon: speechIcon,
            onClick: () => setTool(tool === "text" ? null : "text"),
            testId: "meal-tool-text",
          },
        ] satisfies QuickAction[])
      : []),
    ...(llm.data?.reachable && llm.data.vision && online
      ? ([
          {
            key: "photo",
            label: "meals.photo",
            icon: cameraIcon,
            onClick: () => setTool(tool === "photo" ? null : "photo"),
            testId: "meal-tool-photo",
          },
          {
            key: "recipe",
            label: "meals.recipePhoto",
            icon: recipeIcon,
            onClick: () => setTool(tool === "recipe" ? null : "recipe"),
            testId: "meal-tool-recipe",
          },
        ] satisfies QuickAction[])
      : []),
  ];

  function addPicked(item: FoodItem, picked: PickedAmount) {
    setRows((current) => [
      ...current,
      {
        key: clientUuid(),
        foodItemId: item.id,
        name: item.name,
        amount: picked.amount,
        unit: picked.unit,
        grams: picked.grams,
        food: priceOf(item),
        isEstimate: item.isEstimate,
      },
    ]);
    setPicking(null);
    setNote(t("meals.rowAdded", { name: item.name }));
  }

  /**
   * Rows from a sentence or a photograph arrive as an id, a name and grams.
   * The per-100 g figures are fetched so the running figure can price them
   * with the same calc; a food that cannot be read is left out and said so.
   *
   * **The tool stays open.** The list keeps the rows it could not add, with no
   * amount yet or no match, until a person fills them in or removes them
   * (D143), and closes itself when none are left. Closing the tool here threw
   * those rows away unseen; a recipe, which leaves several at "inte än", is
   * where that showed (D195).
   */
  async function addProposed(proposed: ProposalItem[]) {
    const matched = proposed.filter((row) => row.foodItemId !== null);
    const found = await Promise.all(
      matched.map(async (row) => {
        try {
          return { row, item: await api.getFoodItem(row.foodItemId!) };
        } catch {
          return { row, item: null };
        }
      }),
    );
    const added = found.filter((entry) => entry.item !== null);
    setRows((current) => [
      ...current,
      ...added.map(({ row, item }) => ({
        key: clientUuid(),
        foodItemId: item!.id,
        name: item!.name,
        amount: row.grams,
        unit: "g",
        grams: row.grams,
        food: priceOf(item!),
        isEstimate: item!.isEstimate,
      })),
    ]);
    setNote(plural(added.length, "meals.rowsAddedOne", "meals.rowsAdded"));
  }

  /**
   * A recipe's rows, and for a new meal what the recipe says it is (D195).
   *
   * A yield in portions fills the count; any other yield ("1 PIZZA") empties
   * the field and is shown beside it as printed with "inte än", because one
   * pizza is not a number of helpings and the person knows how many it feeds.
   * The title fills an empty name. A meal that already exists keeps its own.
   */
  async function addRecipe(proposed: ProposalItem[], recipe: RecipeFacts) {
    await addProposed(proposed);
    if (meal) return;
    if (name.trim() === "" && recipe.title) setName(recipe.title.slice(0, 80));
    if (recipe.yield.portions !== null) {
      setPortions(String(recipe.yield.portions));
      setYieldNote(null);
    } else if (recipe.yield.printed !== null) {
      setPortions("");
      setYieldNote(recipe.yield.printed);
    }
  }

  async function onBarcode(code: string) {
    setScanning(false);
    const result = await lookup.mutateAsync(code);
    if (result.item) {
      setPicking(result.item);
      return;
    }
    setNote(result.problem?.message ?? result.notice ?? t("food.barcodeMiss"));
  }

  function startEdit(row: Row) {
    setEditingKey(row.key);
    setEditAmount(formatDecimal(row.amount, { decimals: Number.isInteger(row.amount) ? 0 : 2 }));
  }

  /** A new amount in the same unit: the grams follow in proportion. */
  function saveEdit(row: Row) {
    const parsed = readRequiredNumber(editAmount);
    if (!parsed.ok || parsed.value <= 0) {
      setError(parsed.ok ? t("meals.amountPositive") : parsed.message);
      return;
    }
    const perUnit = row.amount > 0 ? row.grams / row.amount : 1;
    setRows((current) =>
      current.map((candidate) =>
        candidate.key === row.key
          ? {
              ...candidate,
              amount: parsed.value,
              grams: Math.round(parsed.value * perUnit * 10) / 10,
            }
          : candidate,
      ),
    );
    setEditingKey(null);
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (name.trim() === "") {
      setError(t("meals.needName"));
      return;
    }
    if (!portionCount.ok || portionCount.value <= 0) {
      setError(portionCount.ok ? t("meals.portionsPositive") : portionCount.message);
      return;
    }
    if (rows.length === 0) {
      setError(t("meals.needRows"));
      return;
    }

    const items = rows.map((row) => ({
      foodItemId: row.foodItemId,
      nameSnapshot: row.name,
      amount: row.amount,
      unit: row.unit,
      grams: row.grams,
    }));

    setSaving(true);
    try {
      if (meal) {
        await update.mutateAsync({
          id: meal.id,
          input: { name: name.trim(), portions: portionCount.value, items },
        });
      } else {
        const created = await create.mutateAsync({
          clientUuid: clientUuid(),
          name: name.trim(),
          portions: portionCount.value,
          items: items.map((item) => ({ ...item, foodItemId: item.foodItemId! })),
        });
        if (pendingPhoto) {
          await setPhoto.mutateAsync({ mealId: created.id, image: pendingPhoto.base64 });
        }
      }
      onDone(t("meals.saved", { name: name.trim() }));
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : t("save.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-testid="meal-sheet">
      <form onSubmit={save} noValidate>
        <div className="space-y-4">
          <Field id="meal-name" label={t("meals.name")}>
            <input
              id="meal-name"
              className="field"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field id="meal-portions" label={t("meals.portions")} hint={t("meals.portionsHelp")}>
            <input
              id="meal-portions"
              className="field num w-32"
              type="text"
              inputMode="decimal"
              {...fieldAria("meal-portions", undefined)}
              value={portions}
              onChange={(event) => setPortions(event.target.value)}
            />
            {yieldNote ? (
              <p className="mt-1 text-micro text-muted" data-testid="meal-yield-printed">
                {t("recipePhoto.yieldPrinted", { printed: yieldNote })}
                {portions.trim() === "" ? ` · ${t("llm.amountUnknown")}` : ""}
              </p>
            ) : null}
          </Field>
        </div>

        {/*
          The one photo (D191). "Lägg till foto" is an action and filled, at
          the size a row holds (D134); removing it asks first, like any delete.
        */}
        <div className="mt-4 flex items-center gap-4" data-testid="meal-photo">
          {pendingPhoto?.preview ?? photoUrl ? (
            <img
              src={pendingPhoto?.preview ?? photoUrl ?? ""}
              alt={t("meals.photoAlt", { name: name || t("meals.sheetNew") })}
              className="size-24 shrink-0 rounded-lg object-cover"
            />
          ) : null}
          <div className="min-w-0">
            <label className="btn-small cursor-pointer">
              {photoWorking
                ? t("meals.photoWorking")
                : pendingPhoto || photoUrl
                  ? t("meals.photoChange")
                  : t("meals.photoAdd")}
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                data-testid="meal-photo-input"
                disabled={photoWorking}
                onChange={(event) => void choosePhoto(event)}
              />
            </label>
            {meal && photoUrl ? (
              <span className="ml-2 inline-block align-middle">
                <DeleteButton
                  testId="meal-photo-delete"
                  label={t("meals.photoRemove")}
                  onDelete={async () => {
                    await deletePhoto.mutateAsync(meal.id);
                    setPhotoUrl(null);
                  }}
                />
              </span>
            ) : null}
            <p className="mt-1 max-w-prose text-micro text-muted">{t("meals.photoNote")}</p>
          </div>
        </div>

        <div className="mt-4" data-testid="meal-sheet-figures">
          <p className="text-micro text-muted">{t("meals.perPortionHeading")}</p>
          <MealFigures figures={figures} />
        </div>

        <h3 className="mt-6 text-note text-muted">{t("meals.ingredients")}</h3>
        {rows.length === 0 ? (
          <p className="mt-2 max-w-prose text-micro text-muted">{t("meals.noIngredients")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-edge border-y border-edge" data-testid="meal-rows">
            {rows.map((row) => (
              <li key={row.key} className="py-2.5" data-testid="meal-row">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3">
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-note text-ink">{row.name}</span>
                      {row.isEstimate ? (
                        <span className="tag tag-estimate shrink-0">
                          <span aria-hidden="true">≈</span>
                          {t("estimate.badge")}
                        </span>
                      ) : null}
                    </span>
                    <span className="num block text-micro text-muted">
                      {row.unit === "g"
                        ? `${formatDecimal(row.grams, { decimals: 0 })} g`
                        : `${formatDecimal(row.amount, { decimals: Number.isInteger(row.amount) ? 0 : 1 })} ${row.unit} · ${formatDecimal(row.grams, { decimals: 0 })} g`}
                      {" · "}
                      {row.food === null
                        ? t("meals.rowGone")
                        : `${formatKcal((row.food.kcalPer100 * row.grams) / 100)} kcal`}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.food !== null ? (
                      <button
                        type="button"
                        className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
                        onClick={() => startEdit(row)}
                      >
                        {t("meals.changeAmount")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`meal-row-remove-${row.name}`}
                      aria-label={t("meals.removeRowLabel", { name: row.name })}
                      className="min-h-11 px-1 text-micro text-muted underline underline-offset-4"
                      onClick={() => setRows((current) => current.filter((c) => c.key !== row.key))}
                    >
                      {t("meals.removeRow")}
                    </button>
                  </span>
                </div>

                {editingKey === row.key ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="field num w-28"
                      type="text"
                      inputMode="decimal"
                      aria-label={t("meals.amountIn", { unit: row.unit })}
                      value={editAmount}
                      autoFocus
                      onChange={(event) => setEditAmount(event.target.value)}
                    />
                    <span className="text-micro text-muted">{row.unit}</span>
                    <button type="button" className="btn-small" onClick={() => saveEdit(row)}>
                      {t("quick.save")}
                    </button>
                    <button type="button" className="btn-link" onClick={() => setEditingKey(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p role="alert" className="mt-3 max-w-prose text-note text-ink">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            data-testid="meal-save"
            className="btn w-auto px-6"
            disabled={saving}
          >
            {saving ? t("quick.saving") : t("meals.save")}
          </button>
          <button type="button" className="btn-link" onClick={() => onDone("")}>
            {t("common.cancel")}
          </button>
        </div>
      </form>

      {/*
        The ways a row gets in, below the list so the form reads top to bottom:
        what it is called, how many it feeds, what is in it, and then how to add
        more. The same circles as Mat's, because they are the same doors.
      */}
      <div className="mt-8 border-t border-edge pt-4">
        <p className="mb-3 text-micro text-muted">{t("meals.addWays")}</p>
        <nav aria-label={t("meals.addWays")}>
          <ul className="flex flex-wrap items-start justify-center gap-x-4 gap-y-4 sm:gap-x-8">
            {ways.map((action) => (
              <li key={action.key}>
                <ActionButton action={action} />
              </li>
            ))}
          </ul>
        </nav>

        {note ? (
          <p role="status" className="mt-3 max-w-prose text-micro text-muted">
            {note}
          </p>
        ) : null}

        {tool === "search" ? (
          <div className="mt-4" data-testid="meal-search">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setSearchEnabled(true);
              }}
            >
              <input
                className="field flex-1"
                type="search"
                inputMode="search"
                enterKeyHint="search"
                aria-label={t("food.find")}
                placeholder={t("food.searchPlaceholder")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSearchEnabled(false);
                }}
              />
              <button
                type="submit"
                data-testid="meal-search-submit"
                className="btn w-auto"
                disabled={query.trim().length < MIN_SEARCH_LENGTH}
              >
                {t("food.searchAction")}
              </button>
            </form>
            {search.items.length > 0 ? (
              <ul className="mt-3 divide-y divide-edge border-y border-edge">
                {search.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-4 py-3 text-left"
                      onClick={() => {
                        setPicking(item);
                        setQuery("");
                        setSearchEnabled(false);
                      }}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-base text-ink">{item.name}</span>
                        <span className="num block text-micro text-muted">
                          {item.brand ? `${item.brand} · ` : ""}
                          {formatDecimal(item.kcalPer100, { decimals: 0 })} kcal / 100 g
                          <FoodTags item={item} />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <SearchStatus state={search} />
          </div>
        ) : null}

        {tool === "text" ? (
          <div className="mt-4">
            <FoodTextEntry
              localDate=""
              onLogged={setNote}
              collect={{
                label: (count) => plural(count, "meals.addRowsOne", "meals.addRows"),
                onRows: addProposed,
              }}
              onEstimate={(item) => {
                setTool(null);
                setPicking(item);
              }}
            />
          </div>
        ) : null}

        {tool === "photo" ? (
          <div className="mt-4">
            <FoodPhotoEntry
              localDate=""
              onLogged={setNote}
              collect={{
                label: (count) => plural(count, "meals.addRowsOne", "meals.addRows"),
                onRows: addProposed,
              }}
            />
          </div>
        ) : null}

        {tool === "recipe" ? (
          <div className="mt-4">
            <RecipePhotoEntry onRows={addRecipe} />
          </div>
        ) : null}

        {picking ? (
          <AmountPicker
            item={picking}
            confirmLabel={t("meals.addRow")}
            onPick={(picked) => addPicked(picking, picked)}
            onCancel={() => setPicking(null)}
          />
        ) : null}
      </div>

      {/*
        Sharing (D192), on a saved meal and only with a display name: without
        one the control is absent, not greyed. The sharer says the recipe is
        theirs to share, because a cookbook's text belongs to its author, and
        is told who will see what.
      */}
      {meal && publicName !== "" ? (
        <div className="mt-8 border-t border-edge pt-4" data-testid="meal-share">
          <h3 className="text-note text-muted">{t("meals.shareHeading")}</h3>
          {sharedAt ? (
            <div className="mt-2">
              <p className="max-w-prose text-micro text-muted" data-testid="meal-shared-since">
                {t("meals.sharedSince", { date: formatLongDay(sharedAt.slice(0, 10), LOCALE) })}
              </p>
              <button
                type="button"
                data-testid="meal-unshare"
                className="btn-small mt-2"
                disabled={shareMeal.isPending}
                onClick={() =>
                  void shareMeal
                    .mutateAsync({ mealId: meal.id, share: false })
                    .then((saved) => setSharedAt(saved.sharedAt))
                }
              >
                {t("meals.unshare")}
              </button>
            </div>
          ) : (
            <div className="mt-2">
              <p className="max-w-prose text-micro text-muted">
                {t("meals.shareWho", { name: publicName })}
              </p>
              <label className="mt-3 flex max-w-prose items-start gap-3 text-note text-ink">
                <input
                  type="checkbox"
                  className="check mt-1"
                  data-testid="meal-share-confirm"
                  checked={mayShare}
                  onChange={() => setMayShare((was) => !was)}
                />
                <span>{t("meals.shareConfirm")}</span>
              </label>
              <button
                type="button"
                data-testid="meal-share-action"
                className="btn-small mt-3"
                disabled={!mayShare || shareMeal.isPending}
                onClick={() =>
                  void shareMeal
                    .mutateAsync({ mealId: meal.id, share: true })
                    .then((saved) => setSharedAt(saved.sharedAt))
                }
              >
                {t("meals.shareAction")}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {meal ? (
        <div className="mt-8 border-t border-edge pt-4">
          <p className="mb-2 max-w-prose text-micro text-muted">{t("meals.removeNote")}</p>
          <DeleteButton
            testId="meal-delete"
            label={meal.name}
            onDelete={async () => {
              await remove.mutateAsync(meal.id);
              onDone(t("meals.removed", { name: meal.name }));
            }}
          />
        </div>
      ) : null}

      {scanning ? (
        <BarcodeScanner onResult={(code) => void onBarcode(code)} onClose={() => setScanning(false)} />
      ) : null}
    </div>
  );
}
