import type { NormaliseResult } from "shared";

/**
 * The ingest interface.
 *
 * Two implementations today — Open Food Facts and Livsmedelsverket — and the
 * point of the interface is that a third can be added without the routes, the
 * cache or the UI learning about it. Adapters do exactly two things: fetch, and
 * normalise into `NormalisedFood`. They do not write to the database, they do
 * not decide caching policy, and they never invent a number.
 */

export type FoodSearchHit = NormaliseResult;

export interface FoodAdapter {
  /** Stable id, matching `food_source` in the schema. */
  readonly source: "openfoodfacts" | "livsmedelsverket";

  /** Whether this adapter can answer a barcode at all. */
  readonly supportsBarcode: boolean;

  /**
   * One product by barcode. Resolves to `null` when the source simply does not
   * have it, which is different from a normalisation failure.
   */
  lookupBarcode(barcode: string, signal?: AbortSignal): Promise<NormaliseResult | null>;

  /** Free-text search. Returns normalisation results, failures included. */
  search(query: string, limit: number, signal?: AbortSignal): Promise<NormaliseResult[]>;
}

/** Thrown when the upstream is unreachable or refuses. Never a normalisation problem. */
export class AdapterUnavailable extends Error {
  readonly source: string;
  readonly retryAfterMs: number | null;

  constructor(source: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "AdapterUnavailable";
    this.source = source;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Injectable so tests exercise adapters against fixtures rather than the network. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal | undefined; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers: { get(name: string): string | null };
}>;
