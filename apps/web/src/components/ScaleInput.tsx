import { t, type TranslationKey } from "../i18n/index.js";

/**
 * A 1-5 rating as five buttons.
 *
 * Five taps' worth of target area rather than a slider, because this screen is
 * measured in taps and a slider costs a press, a drag and a release to land on
 * a value you then cannot read back at a glance. Buttons are also the only
 * version that works with a thumb on a moving bus.
 *
 * Tapping the selected value again clears it. That matters more than it looks:
 * without it, a mis-tap is permanent, and the alternative — a "clear" button
 * next to every scale — is five more controls on a screen that is trying to be
 * one pass.
 *
 * Unrated stays unrated. There is no default selection, because a pre-selected
 * 3 would flow into the scatter view as data nobody entered (D34).
 */
export function ScaleInput({
  id,
  label,
  value,
  onChange,
  lowLabel,
  highLabel,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  /** What 1 and 5 mean here — "trött" against "pigg" reads better than 1-5. */
  lowLabel?: TranslationKey;
  highLabel?: TranslationKey;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="label mb-1">{label}</legend>
      <div className="flex gap-1.5" role="radiogroup" aria-labelledby={`${id}-legend`}>
        {[1, 2, 3, 4, 5].map((level) => {
          const selected = value === level;
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`${id}-${level}`}
              // Tapping the current value clears it, so a mis-tap is fixable
              // without a sixth control.
              onClick={() => onChange(selected ? null : level)}
              className={[
                "num h-11 flex-1 rounded-md border text-note transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
                selected
                  ? "border-transparent bg-logged text-paper"
                  : "border-edge text-muted hover:border-muted",
              ].join(" ")}
            >
              {/* allow-raw-number: a single digit 1-5, so there is no separator
                  or decimal for a formatter to place. */}
              {level}
            </button>
          );
        })}
      </div>
      {lowLabel && highLabel ? (
        <p className="mt-1 flex justify-between text-[11px] text-muted">
          <span>{t(lowLabel)}</span>
          <span>{t(highLabel)}</span>
        </p>
      ) : null}
    </fieldset>
  );
}
