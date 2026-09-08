import {
  normaliseFailure,
  optionalAmount,
  toKcal,
  type EnergyUnit,
  type NormaliseResult,
} from "shared";
import { categoryFromName } from "./categorise.js";
import { AdapterUnavailable, type FetchLike, type FoodAdapter } from "./adapter.js";
import { RateLimiter, RateLimitExceeded } from "./rate-limit.js";

/**
 * Livsmedelsverket's livsmedelsdatabas — Swedish generic foods.
 *
 * **This is an importer, not a live search adapter**, and that is forced by what
 * the API actually is. The contract check against the real service found three
 * things the fixture-based tests could not:
 *
 *  - `/livsmedel` returns a paginated list of 2606 foods with **no nutrients**;
 *    those live behind a per-food link, so a five-result search would be six
 *    requests;
 *  - the `namn` query parameter **does not filter** — a search for "potatis"
 *    returned "Nöt talg";
 *  - nutrients are keyed by `euroFIRkod`, and energy appears **twice** under the
 *    same code `ENERC`, disambiguated only by `enhet` being `kJ` or `kcal`.
 *
 * So the database is bulk-imported once by `pnpm --filter api import:livsmedelsverket`
 * and searched locally thereafter. That is also the better shape: it is a static
 * reference table of generic foods, not a live product feed, and importing it
 * makes Swedish staples searchable instantly and offline. `search()` therefore
 * returns nothing rather than pretending — the cache-first path in the service
 * finds the imported rows.
 */

/** Conservative: their API documents no limit, and being blocked costs more. */
const REQUESTS_PER_MINUTE = 60;

/** EuroFIR codes. Stable machine identifiers; the Swedish names are display text. */
const CODE = {
  energy: "ENERC",
  protein: "PROT",
  carbs: "CHO",
  fat: "FAT",
  fiber: "FIBT",
  salt: "NACL",
} as const;

export type LivsmedelSummary = { nummer: string; namn: string };

export type LivsmedelsverketOptions = {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  limiter?: RateLimiter;
};

export class LivsmedelsverketAdapter implements FoodAdapter {
  readonly source = "livsmedelsverket" as const;
  /** Generic foods have no barcodes. */
  readonly supportsBarcode = false;

  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  readonly limiter: RateLimiter;

  constructor(options: LivsmedelsverketOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.baseUrl =
      options.baseUrl ?? "https://dataportal.livsmedelsverket.se/livsmedel/api/v1";
    this.limiter = options.limiter ?? new RateLimiter({ limit: REQUESTS_PER_MINUTE });
  }

  /** Generic foods have no barcode, so this always misses rather than guessing. */
  async lookupBarcode(): Promise<NormaliseResult | null> {
    return null;
  }

  /**
   * Always empty. The database is imported, not searched live — see the note
   * above. Returning nothing is honest; the service's cache-first search finds
   * the imported rows in `food_items`.
   */
  async search(): Promise<NormaliseResult[]> {
    return [];
  }

  /** One page of the food list. `nummer` is the id the nutrient endpoint takes. */
  async listFoods(
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ foods: LivsmedelSummary[]; total: number }> {
    const url = `${this.baseUrl}/livsmedel?offset=${offset}&limit=${limit}&sprak=1`;
    const body = await this.request(url, signal);

    const envelope = body as {
      _meta?: { totalRecords?: number };
      livsmedel?: unknown[];
    };
    const rows = Array.isArray(envelope.livsmedel) ? envelope.livsmedel : [];

    return {
      total: envelope._meta?.totalRecords ?? rows.length,
      foods: rows
        .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
        .map((row) => ({
          nummer: String(row.nummer ?? ""),
          namn: firstString(row.namn) ?? "",
        }))
        .filter((food) => food.nummer !== "" && food.namn !== ""),
    };
  }

  /** The nutrient array for one food, ready for `normaliseLivsmedel`. */
  async fetchNutrients(
    nummer: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const url = `${this.baseUrl}/livsmedel/${encodeURIComponent(nummer)}/naringsvarden?sprak=1`;
    const body = await this.request(url, signal);
    return Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  }

  private async request(url: string, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.limiter.run(async () => {
        const response = await this.fetchImpl(url, {
          signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          throw new AdapterUnavailable(
            this.source,
            `Livsmedelsverket answered ${response.status}.`,
          );
        }
        return response.json();
      });
    } catch (error) {
      if (error instanceof RateLimitExceeded) {
        throw new AdapterUnavailable(
          this.source,
          "This server's own rate budget for Livsmedelsverket is used up.",
          error.retryAfterMs,
        );
      }
      if (error instanceof AdapterUnavailable) throw error;
      throw new AdapterUnavailable(this.source, (error as Error).message);
    }
  }
}

/**
 * One food plus its nutrient array into our shape.
 *
 * Keyed on `euroFIRkod`, not on the Swedish display name: the names are
 * localised text and will change, the codes are the contract. Energy appears
 * twice under `ENERC`, once in kJ and once in kcal, so the unit is read from
 * `enhet` rather than assumed — assuming is a factor of 4.184 (food.ts).
 */
export function normaliseLivsmedel(
  food: { nummer: string; namn: string },
  nutrients: readonly Record<string, unknown>[],
): NormaliseResult {
  const name = food.namn?.trim();
  if (!name) return normaliseFailure("no_name");

  /** All entries for a EuroFIR code, since energy has two. */
  const byCode = (code: string) =>
    nutrients.filter((row) => firstString(row.euroFIRkod) === code);

  const amountFor = (code: string): number | null => {
    const [row] = byCode(code);
    return row ? optionalAmount(row.varde) : null;
  };

  const energyRows = byCode(CODE.energy);
  const kcalRow = energyRows.find((row) => firstString(row.enhet)?.toLowerCase() === "kcal");
  const kjRow = energyRows.find((row) => firstString(row.enhet)?.toLowerCase() === "kj");

  let kcalPer100: number | null = null;
  let sourceEnergyUnit: EnergyUnit | null = null;

  // kJ is the authoritative column in this database; the kcal row is derived
  // from it and rounded, so it is the fallback rather than the first choice.
  const kj = kjRow ? optionalAmount(kjRow.varde) : null;
  const kcal = kcalRow ? optionalAmount(kcalRow.varde) : null;

  if (kj !== null) {
    kcalPer100 = toKcal(kj, "kJ");
    sourceEnergyUnit = "kJ";
  } else if (kcal !== null) {
    kcalPer100 = kcal;
    sourceEnergyUnit = "kcal";
  }

  if (kcalPer100 === null || sourceEnergyUnit === null) {
    // The unit was present but unreadable, versus no energy row at all.
    return normaliseFailure(energyRows.length > 0 ? "unknown_energy_unit" : "no_energy");
  }

  return {
    ok: true,
    food: {
      source: "livsmedelsverket",
      sourceRef: food.nummer,
      barcode: null,
      name,
      brand: null,
      kcalPer100,
      sourceEnergyUnit,
      macros: {
        proteinG: amountFor(CODE.protein),
        carbsG: amountFor(CODE.carbs),
        fatG: amountFor(CODE.fat),
        fiberG: amountFor(CODE.fiber),
        saltG: amountFor(CODE.salt),
      },
      servingHints: null,
      /**
       * Livsmedelsverket publishes no taxonomy and no serving data, so the
       * category is matched on the name (D85). A heuristic, and treated as one:
       * a miss is null and the food falls back to grams.
       */
      category: categoryFromName(name),
    },
  };
}

function firstString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
