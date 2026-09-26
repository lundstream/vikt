import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import type { FoodItem, LabelTranscription } from "shared";
import { checkLabel, formatDecimal, formatKcal } from "shared";
import { useCreateLabelFood, useReadLabel } from "../lib/food.js";
import { preparePhoto } from "../lib/photo.js";
import { readRequiredNumber } from "../lib/form-number.js";
import { ApiError } from "../lib/api.js";
import { t, type TranslationKey } from "../i18n/index.js";

/**
 * Photographing a nutrition declaration (Phase 14, D190).
 *
 * **The one place a model's figures reach a food**, and the screen is built
 * around that. The model transcribes; this screen shows the transcription
 * beside the photograph, asks for each figure to be confirmed or corrected,
 * and will not save while the figures disagree with each other by the EU
 * factors (`checkLabel`, which the server runs again). What is saved is an
 * ordinary food of the person's own, marked "från etikett", with no estimate
 * marker, because a printed declaration is a measurement.
 *
 * The photograph is handled exactly as the plate photo is: resized and turned
 * upright on the phone, EXIF stripped, sent once and dropped. It is shown here
 * from memory while the screen is open and nowhere else.
 */

type FigureKey =
  | "energyKcal"
  | "energyKj"
  | "fat"
  | "saturatedFat"
  | "carbohydrate"
  | "sugars"
  | "polyols"
  | "fibre"
  | "protein"
  | "salt"
  | "alcohol";

/** In the order a Swedish declaration prints them. */
const ROWS: { key: FigureKey; label: TranslationKey; unit: string; indent?: boolean }[] = [
  { key: "energyKj", label: "label.energy", unit: "kJ" },
  { key: "energyKcal", label: "label.energy", unit: "kcal" },
  { key: "fat", label: "label.fat", unit: "g" },
  { key: "saturatedFat", label: "label.saturated", unit: "g", indent: true },
  { key: "carbohydrate", label: "label.carbohydrate", unit: "g" },
  { key: "sugars", label: "label.sugars", unit: "g", indent: true },
  { key: "polyols", label: "label.polyols", unit: "g", indent: true },
  { key: "fibre", label: "label.fibre", unit: "g" },
  { key: "protein", label: "label.protein", unit: "g" },
  { key: "salt", label: "label.salt", unit: "g" },
  { key: "alcohol", label: "label.alcohol", unit: "g" },
];

type Draft = Record<FigureKey, string>;

/** As many decimals as the label printed, up to two: "0,13", "4,4", "59". */
function asPrinted(value: number | null): string {
  if (value === null) return "";
  const decimals = Number.isInteger(value) ? 0 : Number.isInteger(value * 10) ? 1 : 2;
  return formatDecimal(value, { decimals });
}

function draftOf(label: LabelTranscription): Draft {
  return Object.fromEntries(ROWS.map((row) => [row.key, asPrinted(label[row.key])])) as Draft;
}

/** A field's number, null when empty, undefined when it is not a number. */
function read(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const parsed = readRequiredNumber(value);
  return parsed.ok && parsed.value >= 0 ? parsed.value : undefined;
}

export function LabelPhotoEntry({
  barcode,
  onSaved,
}: {
  /** The scan that found nothing, attached so the next scan finds this. */
  barcode: string | null;
  onSaved: (item: FoodItem) => void;
}) {
  const readLabel = useReadLabel();
  const create = useCreateLabelFood();

  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [label, setLabel] = useState<LabelTranscription | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState<Set<FigureKey>>(new Set());
  const [serving, setServing] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The picture lives in memory while this screen is open, and no longer.
  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  }, [photoUrl]);

  const working = preparing || readLabel.isPending;

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setMessage(null);
    setLabel(null);
    setPreparing(true);
    const prepared = await preparePhoto(file);
    setPreparing(false);
    if (!prepared.ok) {
      setMessage(prepared.reason === "too_large" ? t("photo.tooLarge") : t("photo.unreadable"));
      return;
    }

    const result = await readLabel.mutateAsync({ image: prepared.base64 });
    if (!result.available) {
      setMessage(result.reason === "rate_limited" ? t("photo.rateLimited") : t("photo.unavailableNow"));
      return;
    }
    if (result.label.columns === 0 || (result.label.energyKcal === null && result.label.energyKj === null)) {
      setMessage(t("label.nothingRead"));
      return;
    }

    setPhotoUrl(URL.createObjectURL(prepared.blob));
    setLabel(result.label);
    setName(result.label.name ?? "");
    setDraft(draftOf(result.label));
    setConfirmed(new Set());
    setServing(
      result.label.servingSize && result.label.servingSize.unit === "g"
        ? formatDecimal(result.label.servingSize.amount, { decimals: 0 })
        : "",
    );
  }

  const values = useMemo(() => {
    if (draft === null) return null;
    return Object.fromEntries(ROWS.map((row) => [row.key, read(draft[row.key])])) as Record<
      FigureKey,
      number | null | undefined
    >;
  }, [draft]);

  const unreadable = values ? ROWS.filter((row) => values[row.key] === undefined) : [];
  const numbers = values
    ? (Object.fromEntries(ROWS.map((row) => [row.key, values[row.key] ?? null])) as Record<FigureKey, number | null>)
    : null;
  const check = numbers ? checkLabel(numbers) : null;
  /** Every figure with a value has been confirmed or typed by the person. */
  const unconfirmed = values
    ? ROWS.filter((row) => values[row.key] !== null && !confirmed.has(row.key))
    : [];

  const canSave =
    check?.ok === true && unreadable.length === 0 && unconfirmed.length === 0 && name.trim() !== "";

  async function save() {
    if (!numbers || !label || !canSave) return;
    const servingGrams = serving.trim() === "" ? null : read(serving);
    try {
      const item = await create.mutateAsync({
        name: name.trim(),
        basis: label.basis ?? "100g",
        energyKj: numbers.energyKj,
        energyKcal: numbers.energyKcal,
        fat: numbers.fat ?? 0,
        saturatedFat: numbers.saturatedFat,
        carbohydrate: numbers.carbohydrate ?? 0,
        sugars: numbers.sugars,
        polyols: numbers.polyols,
        fibre: numbers.fibre,
        protein: numbers.protein ?? 0,
        salt: numbers.salt,
        alcohol: numbers.alcohol,
        servingSize: servingGrams ? { amount: servingGrams, unit: "g" } : null,
        barcode,
      });
      onSaved(item);
    } catch (problem) {
      setError(problem instanceof ApiError ? problem.message : t("save.failed"));
    }
  }

  if (label === null || draft === null) {
    return (
      <div data-testid="label-capture">
        <p className="max-w-prose text-note text-ink">{t("label.intro")}</p>
        <ul className="mt-3 max-w-prose list-disc space-y-1 pl-5 text-note text-muted" data-testid="label-howto">
          <li>{t("label.howFlat")}</li>
          <li>{t("label.howStraight")}</li>
          <li>{t("label.howFill")}</li>
          <li>{t("label.howGlare")}</li>
        </ul>

        <label className="btn mt-4 inline-flex w-auto cursor-pointer items-center px-4">
          {working ? t("photo.working") : t("label.shutter")}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            data-testid="label-input"
            aria-label={t("label.shutter")}
            disabled={working}
            onChange={(event) => void chosen(event)}
          />
        </label>

        {working ? (
          <p role="status" className="mt-2 max-w-prose text-micro text-muted">
            {t("label.waiting")}
          </p>
        ) : null}
        {message ? (
          <p role="status" className="mt-2 max-w-prose text-micro text-muted">
            {message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="label-confirm" className="sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-6">
      {photoUrl ? (
        <img
          src={photoUrl}
          alt={t("label.photoAlt")}
          className="mb-4 max-h-[40vh] w-full rounded-lg object-contain sm:sticky sm:top-0 sm:mb-0 sm:max-h-[70vh]"
        />
      ) : null}

      <div>
        <p className="max-w-prose text-micro text-muted" data-testid="label-column">
          {t("label.readColumn", { column: label.column ?? t("label.per100g") })}
          {label.columns > 1 ? ` ${t("label.moreColumns", { count: label.columns })}` : ""}
        </p>
        <p className="mt-1 max-w-prose text-micro text-muted">{t("label.confirmEach")}</p>

        <label className="label mt-4" htmlFor="label-name">
          {t("label.name")}
        </label>
        <input
          id="label-name"
          className="field"
          value={name}
          maxLength={200}
          placeholder={t("label.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
        />

        <ul className="mt-4 divide-y divide-edge border-y border-edge" data-testid="label-figures">
          {ROWS.map((row) => {
            const value = draft[row.key];
            const id = `label-${row.key}`;
            return (
              <li key={row.key} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-x-3 py-1.5">
                <label htmlFor={id} className={`text-note text-ink ${row.indent ? "pl-4 text-muted" : ""}`}>
                  {t(row.label)}
                </label>
                <span className="relative">
                  <input
                    id={id}
                    className={`field num pr-11 text-right ${values?.[row.key] === undefined ? "border-dashed" : ""}`}
                    type="text"
                    inputMode="decimal"
                    value={value}
                    onChange={(event) => {
                      setDraft({ ...draft, [row.key]: event.target.value });
                      // Typing a figure is confirming it.
                      setConfirmed((current) => new Set(current).add(row.key));
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-micro text-muted"
                  >
                    {row.unit}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="check"
                  data-testid={`label-ok-${row.key}`}
                  aria-label={t("label.confirmFigure", { name: `${t(row.label)} ${row.unit}` })}
                  disabled={values?.[row.key] === null}
                  checked={confirmed.has(row.key)}
                  onChange={() =>
                    setConfirmed((current) => {
                      const next = new Set(current);
                      if (next.has(row.key)) next.delete(row.key);
                      else next.add(row.key);
                      return next;
                    })
                  }
                />
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center gap-3">
          <label htmlFor="label-serving" className="text-note text-ink">
            {t("label.serving")}
          </label>
          <span className="relative w-28">
            <input
              id="label-serving"
              className="field num pr-7 text-right"
              type="text"
              inputMode="decimal"
              value={serving}
              onChange={(event) => setServing(event.target.value)}
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-micro text-muted">
              g
            </span>
          </span>
        </div>

        {/*
          The first guard, said in words: whether the figures add up, and by
          how much when they do not. Snö, no red frame: a figure to check is a
          thing to do, not a failure (§5).
        */}
        <p role="status" className="mt-4 max-w-prose text-note text-ink" data-testid="label-check">
          {check === null
            ? null
            : check.ok
              ? t("label.adds", {
                  computed: formatKcal(check.computedKcal),
                  stated: formatKcal(check.statedKcal),
                })
              : check.reason === "no_energy"
                ? t("label.needEnergy")
                : check.reason === "missing_macros"
                  ? t("label.needMacros")
                  : `${t("label.disagrees")}${
                      check.computedKcal !== null && check.statedKcal !== null
                        ? ` ${t("label.disagreesBy", {
                            computed: formatKcal(check.computedKcal),
                            stated: formatKcal(check.statedKcal),
                          })}`
                        : ""
                    }`}
        </p>
        {unreadable.length > 0 ? (
          <p className="mt-1 text-micro text-muted">{t("label.notANumber")}</p>
        ) : check?.ok && unconfirmed.length > 0 ? (
          <p className="mt-1 text-micro text-muted" data-testid="label-unconfirmed">
            {t("label.stillToConfirm", { count: unconfirmed.length })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-note text-ink">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="label-save"
            className="btn w-auto px-4"
            disabled={!canSave || create.isPending}
            onClick={() => void save()}
          >
            {create.isPending ? t("quick.saving") : t("label.save")}
          </button>
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              setLabel(null);
              setDraft(null);
            }}
          >
            {t("label.again")}
          </button>
        </div>
      </div>
    </div>
  );
}
