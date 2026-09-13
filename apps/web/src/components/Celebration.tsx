import { useEffect, useRef } from "react";
import type { MilestoneDto } from "shared";
import { formatDecimal, formatSek } from "shared";
import { usePrefersReducedMotion } from "../lib/tokens.js";
import { t } from "../i18n/index.js";

/**
 * The moment a milestone is reached. Once.
 *
 * "Once" is a server fact, not a client one: the milestone carries its own
 * `celebrated_at`, and this component acknowledges it on dismissal (D38). A
 * flag in component state would re-fire on every reload, and one in
 * `localStorage` would re-fire on the other device.
 *
 * Deliberately quiet. Section 5 asks for a single considered moment rather than
 * confetti, and this is a product for someone who has been at this for months:
 * the reward for reaching 100 kg is being told plainly that you reached it, and
 * what you have earned. Reduced motion is respected, so the entrance is a fade
 * or nothing at all.
 */
export function Celebration({
  milestone,
  onDismiss,
}: {
  milestone: MilestoneDto;
  onDismiss: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const dismissRef = useRef<HTMLButtonElement>(null);

  // Focus the dismissal, so the keyboard and a screen reader both land on the
  // thing that closes it rather than somewhere behind the dialog.
  useEffect(() => {
    dismissRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      className="scrim fixed z-50 grid place-items-center px-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="celebration-title"
      data-testid="celebration"
    >
      <div
        className={[
          "w-full max-w-sm rounded-lg border border-edge bg-paper p-6 text-center",
          reducedMotion ? "" : "animate-[fadeIn_320ms_ease-out]",
        ].join(" ")}
      >
        <p className="text-note text-muted">{t("celebrate.reached")}</p>
        <h2 id="celebration-title" className="num mt-2 text-2xl text-ink">
          {milestone.label}
        </h2>

        {milestone.achievedValue !== null ? (
          <p className="num mt-1 text-note text-muted">
            {/*
              Through the shared formatter, like every other number in the app
              (D26). `String(87.27)` renders a full stop and two decimals, in a
              Swedish interface, on the one screen someone will actually stop
              and read.
            */}
            {t("celebrate.atValue", {
              value: formatDecimal(milestone.achievedValue, { maxDecimals: 1 }),
            })}
          </p>
        ) : null}

        {milestone.rewardText ? (
          <div className="mt-5 border-t border-edge pt-5">
            <p className="text-note text-muted">{t("celebrate.earned")}</p>
            <p className="mt-1 text-base text-ink">{milestone.rewardText}</p>
            {milestone.rewardCostSek !== null ? (
              <p className="num mt-2 text-note text-muted">
                {milestone.rewardAffordable
                  ? t("celebrate.potCovers", {
                      cost: formatSek(milestone.rewardCostSek),
                    })
                  : t("celebrate.potShort", {
                      cost: formatSek(milestone.rewardCostSek),
                    })}
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          ref={dismissRef}
          type="button"
          data-testid="celebration-dismiss"
          className="btn mt-6"
          onClick={onDismiss}
        >
          {t("celebrate.dismiss")}
        </button>
      </div>
    </div>
  );
}
