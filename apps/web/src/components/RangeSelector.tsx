import { t } from "../i18n/index.js";

export const RANGES = [
  { key: "30", labelKey: "range.30", days: 30 },
  { key: "90", labelKey: "range.90", days: 90 },
  { key: "365", labelKey: "range.365", days: 365 },
  { key: "all", labelKey: "range.all", days: null },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export function rangeDays(key: RangeKey): number | null {
  return RANGES.find((range) => range.key === key)?.days ?? null;
}

/**
 * Segmented control. Small, quiet, and out of the way — the line is the thing
 * on this screen, not the chrome around it.
 */
export function RangeSelector({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (key: RangeKey) => void;
}) {
  return (
    <div
      role="group"
      aria-label={t("range.label")}
      className="inline-flex rounded-lg border border-edge p-0.5"
    >
      {RANGES.map((range) => {
        const selected = range.key === value;
        return (
          <button
            key={range.key}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(range.key)}
            className={[
              "num rounded px-3 py-1.5 text-micro transition-colors",
              selected ? "bg-ink text-paper" : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {t(range.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
