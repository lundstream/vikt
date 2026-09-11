import { useState, type FormEvent } from "react";
import type { FoodItem } from "shared";
import { fieldAria } from "./Field.js";
import { useCreateEstimate, useEstimateDish, useLlmHealth } from "../lib/food.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { t } from "../i18n/index.js";

/**
 * Restaurant and takeaway food, where no database has anything (§3b, D80).
 *
 * The independent pizzeria, the Thai place, the office canteen. There is no
 * barcode and nothing to search, so the alternative to letting someone type a
 * figure is the day going unlogged — which is worse for every number downstream
 * than an honest guess is, because §4.2's maintenance figure is computed over
 * the days that *were* logged and people skip the large meal more often than
 * the small one.
 *
 * Three things make the guess safe to keep:
 *
 * **It asks for the portion, not per 100 g.** Nobody knows the kcal per 100 g
 * of a pizza. They know roughly what they ate and roughly what it was worth,
 * and the per-100 g figure the cache needs is derived from that pair.
 *
 * **It is remembered.** The same pizzeria recurs, and re-typing the guess every
 * Friday would put a different number into the intake series each time for the
 * same meal. A remembered estimate is one number, editable, reusable, starrable.
 *
 * **It is marked, permanently.** Every screen the item reaches says it is an
 * estimate, and §4.2 knows how much of its window came from ones (D82).
 *
 * The model button is the narrow exception (D81) and appears only after the
 * other paths have been tried, because that is the condition the exception is
 * granted under rather than a UI preference.
 */
export function EstimateEntry({
  dish,
  after,
  onCreated,
}: {
  /** What the user was trying to log, if they got here from a failed attempt. */
  dish?: string;
  /** What the app already tried, which is what licenses the model button. */
  after?: "not_found" | "decomposed_empty" | "decomposed_rejected";
  onCreated: (item: FoodItem) => void;
}) {
  const create = useCreateEstimate();
  const estimate = useEstimateDish();
  const health = useLlmHealth();

  const [name, setName] = useState(dish ?? "");
  const [brand, setBrand] = useState("");
  const [kcal, setKcal] = useState("");
  const [grams, setGrams] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [basis, setBasis] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The model's proposal, before anyone has accepted it. */
  const [proposed, setProposed] = useState<{ low: number; high: number } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const energy = readRequiredNumber(kcal);
    if (!energy.ok) return setError(energy.message);
    const weight = readRequiredNumber(grams);
    if (!weight.ok) return setError(weight.message);

    /**
     * Macros are optional, and a blank field means unknown rather than zero.
     *
     * D55's coverage rule depends on that distinction: a restaurant item with
     * calories but no protein figure must leave the day's protein *unknown*,
     * not quietly depress it toward a target it was never measured against.
     */
    const optional = (raw: string) => {
      if (raw.trim() === "") return null;
      const parsed = readRequiredNumber(raw);
      return parsed.ok ? parsed.value : null;
    };

    const item = await create.mutateAsync({
      name: name.trim(),
      brand: brand.trim() === "" ? null : brand.trim(),
      kcal: energy.value,
      grams: weight.value,
      proteinG: optional(protein),
      carbsG: optional(carbs),
      fatG: optional(fat),
      basis: basis.trim() === "" ? null : basis.trim(),
    });

    onCreated(item);
  }

  /**
   * The exception, asked for explicitly (D81).
   *
   * Fills the form rather than saving: the figure arrives as a proposal with
   * its range and its reasoning, the user edits it if they disagree, and the
   * ordinary save is what writes it. That is the difference between the model
   * estimating and the model deciding.
   */
  async function askModel() {
    if (!after) return;
    setError(null);

    const result = await estimate.mutateAsync({
      dish: name.trim(),
      after,
      requested: true,
    });

    if (!result.available) {
      setError(t("estimate.modelUnavailable"));
      return;
    }

    setKcal(String(result.kcal));
    setGrams(String(result.grams));
    setProtein(result.proteinG === null ? "" : String(result.proteinG));
    setCarbs(result.carbsG === null ? "" : String(result.carbsG));
    setFat(result.fatG === null ? "" : String(result.fatG));
    setBasis(result.basis);
    setProposed({ low: result.kcalLow, high: result.kcalHigh });
  }

  const canAskModel = after !== undefined && health.data?.reachable === true;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="max-w-prose text-micro text-muted">{t("estimate.intro")}</p>

      <label className="block text-micro text-muted">
        {t("estimate.name")}
        <input
          id="estimate-name"
          className="field mt-1 w-full"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("estimate.namePlaceholder")}
        />
      </label>

      <label className="block text-micro text-muted">
        {t("estimate.place")}
        <input
          id="estimate-brand"
          className="field mt-1 w-full"
          value={brand}
          onChange={(event) => setBrand(event.target.value)}
          placeholder={t("estimate.placePlaceholder")}
        />
      </label>

      {/*
        The model button, only where the exception applies. Absent entirely when
        the workstation is off, like every other optional-layer control.
      */}
      {canAskModel ? (
        <div>
          <button
            type="button"
            data-testid="ask-model"
            className="btn  disabled:opacity-50"
            onClick={() => void askModel()}
            disabled={name.trim().length < 3 || estimate.isPending}
          >
            {estimate.isPending ? t("estimate.asking") : t("estimate.askModel")}
          </button>
          <p className="mt-1 max-w-prose text-micro text-muted">{t("estimate.askHint")}</p>
        </div>
      ) : null}

      <div className="flex gap-3">
        <label className="block flex-1 text-micro text-muted">
          {t("estimate.kcal")}
          <input
            id="estimate-kcal"
            className="field num mt-1 w-full"
            inputMode="decimal"
            value={kcal}
            onChange={(event) => setKcal(event.target.value)}
            {...fieldAria("estimate-kcal", error ?? undefined)}
          />
        </label>
        <label className="block flex-1 text-micro text-muted">
          {t("estimate.grams")}
          <input
            id="estimate-grams"
            className="field num mt-1 w-full"
            inputMode="decimal"
            value={grams}
            onChange={(event) => setGrams(event.target.value)}
          />
        </label>
      </div>

      {/*
        The range, when a model proposed the figure. The width is the honest
        part: a burger it knows is 650 to 950, a dish it does not is 400 to 1200,
        and a person can act on that difference.
      */}
      {proposed ? (
        <p className="num text-micro text-muted" data-testid="estimate-range">
          {t("estimate.range", { low: String(proposed.low), high: String(proposed.high) })}
        </p>
      ) : null}

      <div className="flex gap-3">
        {(
          [
            ["estimate-protein", t("macro.protein"), protein, setProtein],
            ["estimate-carbs", t("macro.carbs"), carbs, setCarbs],
            ["estimate-fat", t("macro.fat"), fat, setFat],
          ] as const
        ).map(([id, label, value, set]) => (
          <label key={id} className="block flex-1 text-micro text-muted">
            {label}
            <input
              id={id}
              className="field num mt-1 w-full"
              inputMode="decimal"
              value={value}
              onChange={(event) => set(event.target.value)}
            />
          </label>
        ))}
      </div>

      {/*
        What the guess was based on. Kept with the item, so a figure someone
        looks at in six weeks can be judged rather than merely trusted.
      */}
      <label className="block text-micro text-muted">
        {t("estimate.basis")}
        <input
          id="estimate-basis"
          className="field mt-1 w-full"
          value={basis}
          onChange={(event) => setBasis(event.target.value)}
          placeholder={t("estimate.basisPlaceholder")}
        />
      </label>

      {error ? (
        <p role="status" className="text-micro text-muted">
          {error}
        </p>
      ) : null}

      <button
        className="btn"
        type="submit"
        data-testid="save-estimate"
        disabled={name.trim().length === 0 || create.isPending}
      >
        {create.isPending ? t("quick.saving") : t("estimate.save")}
      </button>
    </form>
  );
}
