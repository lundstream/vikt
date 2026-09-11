import { Link } from "react-router-dom";
import { t } from "../i18n/index.js";
import { useCurrentReview, useDismissReview } from "../lib/coach.js";
import { useLlmHealth } from "../lib/food.js";

/**
 * The week's review, on the dashboard, once (D139).
 *
 * The shape is the welcome card's and the maintenance banner's, and it is that
 * shape for the reason the 8b amendment gives: a weekly review is **news**.
 * Worth seeing, worth seeing once, and not worth a permanent fixture on the
 * screen somebody opens to log breakfast. "Läs hela" leads to the Coach page,
 * where it sits with the others and with the chat.
 *
 * **Dismissed on the row, not in the browser** (D108). A card put away on the
 * phone has to stay away on the laptop; a per-device dismissal is the same card
 * coming back for the same person about the same week.
 *
 * **No accent.** §5 gives an accent to an *area* — the trend, logged, money,
 * nutrition, a secondary measurement — and a coach is none of those. Snö and
 * Sten, like everything else that is not one of the five.
 */
export function ReviewCard() {
  const health = useLlmHealth();
  const configured = health.data?.configured === true;

  const review = useCurrentReview(configured);
  const dismiss = useDismissReview();

  // Absent rather than empty: with the layer off there is no card, no route and
  // no navigation entry (D94).
  if (!configured || review.data == null) return null;

  return (
    <section className="panel mb-4" data-testid="review-card">
      <p className="text-micro text-muted">
        {t("coach.weekOf", { date: review.data.weekStart })}
      </p>

      {/*
        The opening of the review rather than the whole of it. A card is an
        invitation to read, and the page is where it is read.
      */}
      <p className="mt-2 line-clamp-3 text-body text-ink">{review.data.body}</p>

      <div className="mt-3 flex flex-wrap items-baseline gap-4">
        <Link className="btn-link text-note" to="/coach" data-testid="review-open">
          {t("coach.readAll")}
        </Link>
        <button
          type="button"
          className="btn-link text-micro"
          data-testid="review-dismiss"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate(review.data!.id)}
        >
          {t("coach.dismiss")}
        </button>
      </div>
    </section>
  );
}
