import type { FoodItem } from "shared";
import { t } from "../i18n/index.js";

/**
 * What kind of figures a food carries, said next to it wherever it is listed.
 *
 * Two states, in the profile's state-chip style (page 6). An estimate is Sten
 * with a dashed edge and a `≈` (D80): somebody guessed. A food transcribed from
 * a photographed label is "från etikett", Sten with a **solid** edge and no
 * `≈` (D190): the figures were printed by the manufacturer, read by a model and
 * confirmed by the person, which is a measurement, and marking it as a guess
 * would teach people to ignore the marker that means one. No accent for
 * either: neither is an area (§5).
 */
export function FoodTags({ item }: { item: Pick<FoodItem, "isEstimate" | "source"> }) {
  if (item.isEstimate) {
    return (
      <span className="tag tag-estimate ml-2 align-middle">
        <span aria-hidden="true">≈</span>
        {t("estimate.badge")}
      </span>
    );
  }
  if (item.source === "label_photo") {
    return (
      <span className="tag tag-quiet ml-2 align-middle" data-testid="tag-label">
        {t("label.chip")}
      </span>
    );
  }
  return null;
}
