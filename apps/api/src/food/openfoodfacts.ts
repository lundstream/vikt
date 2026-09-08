import { categoryFromTags } from "./categorise.js";
import {
  energyPairAgrees,
  normaliseFailure,
  optionalAmount,
  toKcal,
  type EnergyUnit,
  type NormaliseResult,
} from "shared";
import {
  AdapterUnavailable,
  type FetchLike,
  type FoodAdapter,
} from "./adapter.js";
import { RateLimiter, RateLimitExceeded } from "./rate-limit.js";

/**
 * Open Food Facts.
 *
 * Their published limits are **15 requests a minute for product reads** and
 * **10 a minute for search**, per IP. Every call from this app leaves one
 * server address, so those budgets are shared across all users of the instance
 * — see `rate-limit.ts`. They also require a descriptive User-Agent identifying
 * the application and a contact, and will block generic ones.
 *
 * The data is ODbL — see DECISIONS.md D29 for the attribution obligation that
 * comes with caching it.
 */

/**
 * Fields the search service is asked for.
 *
 * `code` matters as much as the nutrition: it is the barcode, and without it a
 * searched product cannot be told apart from another with the same name when it
 * is written into the cache.
 */
const SEARCH_FIELDS = [
  "code",
  "categories_tags",
  "product_name",
  "brands",
  "nutriments",
  "serving_size",
  "serving_quantity",
].join(",");

const PRODUCT_LIMIT_PER_MINUTE = 15;
const SEARCH_LIMIT_PER_MINUTE = 10;

/**
 * Required by Open Food Facts. Identifies the app and a contact so they can get
 * in touch rather than block an anonymous client.
 */
export const OFF_USER_AGENT =
  "Vikt/0.1 (self-hosted personal weight tracker; +https://github.com/lundstream/vikt)";

const PRODUCT_FIELDS = [
  "code",
  // The taxonomy the household-measure category is read from (D85).
  "categories_tags",
  "product_name",
  "product_name_sv",
  "brands",
  "serving_quantity",
  "nutriments",
].join(",");

type Nutriments = Record<string, unknown>;

export type OpenFoodFactsOptions = {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** The full-text search service. Separate host, separate contract. */
  searchUrl?: string;
  productLimiter?: RateLimiter;
  searchLimiter?: RateLimiter;
  userAgent?: string;
};

export class OpenFoodFactsAdapter implements FoodAdapter {
  readonly source = "openfoodfacts" as const;
  readonly supportsBarcode = true;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly searchUrl: string;
  private readonly userAgent: string;
  readonly productLimiter: RateLimiter;
  readonly searchLimiter: RateLimiter;

  constructor(options: OpenFoodFactsOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl = options.baseUrl ?? "https://world.openfoodfacts.org";
    this.searchUrl = options.searchUrl ?? "https://search.openfoodfacts.org";
    this.userAgent = options.userAgent ?? OFF_USER_AGENT;
    this.productLimiter =
      options.productLimiter ?? new RateLimiter({ limit: PRODUCT_LIMIT_PER_MINUTE });
    this.searchLimiter =
      options.searchLimiter ?? new RateLimiter({ limit: SEARCH_LIMIT_PER_MINUTE });
  }

  async lookupBarcode(barcode: string, signal?: AbortSignal): Promise<NormaliseResult | null> {
    const url = `${this.baseUrl}/api/v2/product/${encodeURIComponent(barcode)}?fields=${PRODUCT_FIELDS}`;
    const body = await this.request(this.productLimiter, url, signal);

    const payload = body as { status?: number; product?: Record<string, unknown> };
    if (payload.status !== 1 || !payload.product) return null;

    return normaliseProduct(payload.product, barcode);
  }

  /**
   * Free-text search, against the search service rather than the product API.
   *
   * This used to call `/api/v2/search?search_terms=`, and **that parameter does
   * nothing**. The endpoint answers every query with page one of the entire
   * database: a search for "kvarg", for "proteinpulver" and for "star nutrition"
   * all came back with the same four Moroccan dairy products, and `count` on the
   * response was 4 730 807, which is the whole of Open Food Facts. Worse than
   * useless, because those results were then written into the shared
   * `food_items` cache as though they were matches, so "Sidi Ali" became a
   * cached hit for "rågbröd".
   *
   * The same class of defect as the one already documented for
   * Livsmedelsverket's `namn` parameter, which also does not filter. Two
   * out of two food APIs have shipped a search parameter that is silently
   * ignored, which is why the check below asserts on *what came back* and not
   * just on the status code.
   *
   * `search.openfoodfacts.org` is the service that does filter. It answers with
   * `hits` rather than `products`, and `brands` is an array there rather than a
   * comma-separated string, so the shape is normalised before it reaches the
   * shared normaliser.
   */
  async search(query: string, limit: number, signal?: AbortSignal): Promise<NormaliseResult[]> {
    const url =
      `${this.searchUrl}/search?q=${encodeURIComponent(query)}` +
      `&fields=${SEARCH_FIELDS}&page_size=${Math.min(limit, 24)}`;
    const body = await this.request(this.searchLimiter, url, signal);

    const hits = (body as { hits?: unknown[] }).hits ?? [];
    return hits
      .filter((hit): hit is Record<string, unknown> => typeof hit === "object" && hit !== null)
      .map((hit) => normaliseProduct(fromSearchHit(hit), null));
  }

  private async request(
    limiter: RateLimiter,
    url: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await limiter.run(async () => {
        const response = await this.fetchImpl(url, {
          signal,
          headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        });

        if (response.status === 429) {
          const retry = Number(response.headers.get("retry-after") ?? "60");
          throw new AdapterUnavailable(
            this.source,
            "Open Food Facts is rate limiting this server.",
            Number.isFinite(retry) ? retry * 1000 : 60_000,
          );
        }
        if (!response.ok) {
          throw new AdapterUnavailable(
            this.source,
            `Open Food Facts answered ${response.status}.`,
          );
        }
        return response.json();
      });
    } catch (error) {
      if (error instanceof RateLimitExceeded) {
        throw new AdapterUnavailable(
          this.source,
          "This server's own rate budget for Open Food Facts is used up.",
          error.retryAfterMs,
        );
      }
      if (error instanceof AdapterUnavailable) throw error;
      throw new AdapterUnavailable(this.source, (error as Error).message);
    }
  }
}

/**
 * Turns one OFF product into our shape, or says why it cannot.
 *
 * Energy is the whole difficulty. OFF carries `energy-kcal_100g` and
 * `energy-kj_100g`, sometimes only one, sometimes a bare `energy_100g` whose
 * unit lives in `energy_unit`, and sometimes values that disagree. Every path
 * that cannot be resolved to a *known* unit returns a failure rather than a
 * number (see food.ts).
 */
export function normaliseProduct(
  product: Record<string, unknown>,
  fallbackBarcode: string | null,
): NormaliseResult {
  const name =
    firstString(product.product_name_sv) ?? firstString(product.product_name) ?? null;
  if (!name) return normaliseFailure("no_name");

  const nutriments = (product.nutriments ?? {}) as Nutriments;

  const kcalDirect = optionalAmount(nutriments["energy-kcal_100g"]);
  const kjDirect = optionalAmount(nutriments["energy-kj_100g"]);

  // When both are present they must agree, or the record is not trustworthy.
  const agreement = energyPairAgrees(kcalDirect, kjDirect);
  if (agreement === false) return normaliseFailure("inconsistent_energy");

  let kcalPer100: number | null = null;
  let sourceEnergyUnit: EnergyUnit | null = null;

  if (kcalDirect !== null) {
    kcalPer100 = kcalDirect;
    sourceEnergyUnit = "kcal";
  } else if (kjDirect !== null) {
    kcalPer100 = toKcal(kjDirect, "kJ");
    sourceEnergyUnit = "kJ";
  } else {
    // The generic `energy_100g`, whose unit is stated separately.
    const generic = optionalAmount(nutriments["energy_100g"]);
    const declared = firstString(nutriments["energy_unit"])?.toLowerCase();
    const unit: EnergyUnit | null =
      declared === "kcal" ? "kcal" : declared === "kj" ? "kJ" : null;

    if (generic === null) return normaliseFailure("no_energy");
    if (unit === null) return normaliseFailure("unknown_energy_unit");

    kcalPer100 = toKcal(generic, unit);
    sourceEnergyUnit = unit;
  }

  if (kcalPer100 === null || sourceEnergyUnit === null) {
    return normaliseFailure("no_energy");
  }

  return {
    ok: true,
    food: {
      source: "openfoodfacts",
      sourceRef: firstString(product.code) ?? fallbackBarcode,
      barcode: firstString(product.code) ?? fallbackBarcode,
      name: name.trim(),
      brand: firstString(product.brands)?.split(",")[0]?.trim() ?? null,
      kcalPer100,
      sourceEnergyUnit,
      macros: {
        proteinG: optionalAmount(nutriments["proteins_100g"]),
        carbsG: optionalAmount(nutriments["carbohydrates_100g"]),
        fatG: optionalAmount(nutriments["fat_100g"]),
        fiberG: optionalAmount(nutriments["fiber_100g"]),
        saltG: optionalAmount(nutriments["salt_100g"]),
      },
      servingHints: servingHints(product),
      // Which household measures apply (D85). Null for the long tail of
      // composite products, which have no useful one.
      category: categoryFromTags(product.categories_tags),
    },
  };
}

/**
 * The serving figure, under the name the packet gives it.
 *
 * `serving_quantity` is the grams and was already being read; what was being
 * thrown away is `serving_size`, the text beside it — "1 skiva (35 g)",
 * "2 kex", "1 portion (250 g)". That text carries the **unit name**, which is
 * the half a person can actually count. Storing the grams under the generic key
 * `portion` loses it, and "5 skivor" then has nothing to resolve against.
 *
 * Crowdsourced and frequently messy, so the parse is deliberately narrow: a
 * leading count and a word, and nothing clever about the rest. A serving text
 * that is only a mass ("30 g") has no unit in it and falls back to `portion`,
 * which is true and is what it was before.
 */
function servingHints(product: Record<string, unknown>): Record<string, number> | null {
  const serving = optionalAmount(product.serving_quantity);
  if (serving === null || serving <= 0) return null;

  const unit = servingUnit(firstString(product.serving_size));

  /**
   * The grams are per **one** of the unit, so a "2 kex (25 g)" serving is
   * 12.5 g per kex. Getting this backwards would double every count the user
   * ever states, which is the kind of error that looks like a plausible
   * portion rather than like a bug.
   */
  if (unit === null) return { portion: serving };

  const per = Math.round((serving / unit.count) * 100) / 100;
  return per > 0 ? { [unit.name]: per } : { portion: serving };
}

/**
 * A count and a unit word out of a serving text, or null.
 *
 * Only the leading "<number> <word>" is read, and only when the word is not a
 * unit of **mass**: recording "g" as a portion name would create a hint saying
 * one gram weighs thirty grams.
 *
 * Volume is deliberately kept. "2 dl (200 g)" is not circular the way "30 g"
 * is; it is a *density*, which is the one thing standing between an ingredient
 * list and "1,5 dl mjölk", and there is nowhere else in the system to get it.
 */
const MASS_UNITS = new Set(["g", "gram", "gr", "kg", "mg", "oz", "lb"]);

function servingUnit(text: string | null): { count: number; name: string } | null {
  if (text === null) return null;

  const match = /^\s*(\d+(?:[.,]\d+)?)\s*([a-zà-öø-ÿ]{2,20})/i.exec(text);
  if (!match) return null;

  const count = Number(match[1]!.replace(",", "."));
  const name = match[2]!.toLowerCase();
  if (!Number.isFinite(count) || count <= 0) return null;
  if (MASS_UNITS.has(name)) return null;

  return { count, name };
}

function firstString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A search hit in the shape the product normaliser expects.
 *
 * Two differences, both silent if unhandled. `brands` arrives as an array from
 * the search service and as a comma-separated string from the product API, and
 * a raw array reaching `firstString` yields no brand at all rather than an
 * error. And the barcode is `code` in both, but only the search service omits
 * it when the field is not asked for, which is why it is in `SEARCH_FIELDS`.
 */
export function fromSearchHit(hit: Record<string, unknown>): Record<string, unknown> {
  const brands = hit.brands;
  return {
    ...hit,
    brands: Array.isArray(brands) ? brands.filter((b) => typeof b === "string").join(", ") : brands,
  };
}
