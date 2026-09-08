import type { PlanReviewDto } from "shared";
import { formatDecimal, formatKcal } from "shared";
import { Link } from "react-router-dom";
import { t } from "../i18n/index.js";

/**
 * The plan was validated once, against a figure designed to change — D25.
 *
 * This says what changed and what the plan now implies. It does **not** fix
 * anything: the plan is the user's statement of intent, and quietly rewriting
 * their targets because an estimate improved would be worse than firing late.
 *
 * Tone follows §3. Nothing here is a failure — the estimate got better, which
 * is the system working. So it is set in `--ink` on the page background rather
 * than in a warning colour, and the dismiss action is a real option.
 */
export function PlanReviewNotice({
  review,
  targetIntakeKcal,
  onDismiss,
}: {
  review: PlanReviewDto;
  targetIntakeKcal: number | null;
  onDismiss: () => void;
}) {
  const rate = (value: number) => formatDecimal(Math.abs(value), { decimals: 2 });

  return (
    <section
      aria-label={t("review.title")}
      className="rounded-lg border border-edge bg-edge/20 p-4"
    >
      <h3 className="text-note font-medium text-ink">{t("review.title")}</h3>

      <p className="mt-2 max-w-prose text-note text-muted">
        {review.reason === "source_improved"
          ? t("review.sourceImproved", { current: formatKcal(review.currentTdee) })
          : t("review.tdeeMoved", {
              previous: formatKcal(review.previousTdee ?? 0),
              current: formatKcal(review.currentTdee),
            })}
      </p>

      {targetIntakeKcal !== null ? (
        <p className="num mt-2 max-w-prose text-note text-muted">
          {t("review.impliedRate", {
            target: formatKcal(targetIntakeKcal),
            implied: rate(review.impliedRateKgWeek),
          })}{" "}
          {review.plannedRateKgWeek !== null
            ? t("review.plannedRate", { planned: rate(review.plannedRateKgWeek) })
            : null}
        </p>
      ) : null}

      {review.violations.length > 0 ? (
        <>
          <p className="mt-3 text-note text-ink">{t("review.nowBreaks")}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-note text-muted">
            {review.violations.map((violation) => (
              <li key={violation.code}>{violation.message}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 max-w-prose text-note text-muted">{t("review.stillFine")}</p>
      )}

      <div className="mt-4 flex items-center gap-5">
        <Link
          to="/profile"
          className="text-note font-medium text-ink underline underline-offset-4"
        >
          {t("review.openPlan")}
        </Link>
        <button
          type="button"
          className="text-note text-muted underline underline-offset-4"
          onClick={onDismiss}
        >
          {t("review.dismiss")}
        </button>
      </div>
    </section>
  );
}
