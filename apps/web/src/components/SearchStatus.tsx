import type { FoodSearchState } from "../lib/food.js";
import { t } from "../i18n/index.js";

/**
 * One line under the search results that says where the search is (D165).
 *
 * "Söker" is in Sten, the colour of what is not known yet. The line names the
 * food database while it is being asked, keeps the local rows on screen when it
 * does not answer in time, and says "inget hittat" only once every source has
 * answered, because a search that timed out has not found nothing, it has not
 * finished.
 */
export function SearchStatus({ state }: { state: FoodSearchState }) {
  const text = message(state);
  if (text === null) return null;

  const pending = state.searching !== null;

  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="search-status"
      className={`mt-2 text-micro ${pending ? "text-uncertain" : "text-muted"}`}
    >
      {text}
    </p>
  );
}

function message(state: FoodSearchState): string | null {
  if (state.searching === "local") return t("food.searching");
  if (state.searching === "remote") {
    return state.items.length > 0 ? t("food.searchingMore") : t("food.searchingRemote");
  }
  if (state.failed) return t("food.searchFailed");
  if (state.timedOut) {
    return state.items.length > 0 ? t("food.searchTimeoutWithLocal") : t("food.searchTimeoutEmpty");
  }
  if (state.notice) return state.notice;
  if (state.nothingFound) return t("food.nothingFound", { query: state.query });
  return null;
}
