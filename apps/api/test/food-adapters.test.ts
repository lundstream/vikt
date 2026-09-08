import { describe, expect, it, vi } from "vitest";
import { OFF_USER_AGENT, OpenFoodFactsAdapter, normaliseProduct } from "../src/food/openfoodfacts.js";
import { LivsmedelsverketAdapter, normaliseLivsmedel } from "../src/food/livsmedelsverket.js";
import { AdapterUnavailable, type FetchLike } from "../src/food/adapter.js";
import { RateLimiter, RateLimitExceeded } from "../src/food/rate-limit.js";

/** A fetch that answers from a fixture and records what it was asked. */
function stubFetch(
  responder: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; headers: Record<string, string> | undefined }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const { status = 200, body = {}, headers = {} } = responder(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    };
  };
  return { impl, calls };
}

describe("Open Food Facts: energy units", () => {
  /**
   * The hazard. European product data commonly carries kJ, and reading it as
   * kcal is a factor of 4.184 straight into the series TDEE is computed from.
   */
  it("converts a kJ-only product rather than reading the number as kcal", () => {
    const result = normaliseProduct(
      {
        code: "7310865004703",
        product_name: "Havregryn",
        nutriments: { "energy-kj_100g": 1500, proteins_100g: 13 },
      },
      null,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.food.kcalPer100).toBeCloseTo(358.51, 2);
    expect(result.food.kcalPer100).not.toBeCloseTo(1500, 0);
    // The source unit is kept so the conversion can be re-checked later.
    expect(result.food.sourceEnergyUnit).toBe("kJ");
  });

  it("uses a kcal figure directly when the source gives one", () => {
    const result = normaliseProduct(
      { code: "1", product_name: "X", nutriments: { "energy-kcal_100g": 359 } },
      null,
    );
    expect(result.ok && result.food.kcalPer100).toBe(359);
    expect(result.ok && result.food.sourceEnergyUnit).toBe("kcal");
  });

  it("prefers kcal when both are present and they agree", () => {
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "X",
        nutriments: { "energy-kcal_100g": 359, "energy-kj_100g": 1502 },
      },
      null,
    );
    expect(result.ok && result.food.kcalPer100).toBe(359);
  });

  it("refuses a product whose kcal and kJ contradict each other", () => {
    // Somebody put the kJ figure in the kcal field.
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "X",
        nutriments: { "energy-kcal_100g": 1500, "energy-kj_100g": 1500 },
      },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("inconsistent_energy");
  });

  it("reads the generic energy field when its unit is declared", () => {
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "X",
        nutriments: { energy_100g: 1500, energy_unit: "kJ" },
      },
      null,
    );
    expect(result.ok && result.food.kcalPer100).toBeCloseTo(358.51, 2);
  });

  it("refuses the generic energy field when its unit is not declared", () => {
    const result = normaliseProduct(
      { code: "1", product_name: "X", nutriments: { energy_100g: 1500 } },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("unknown_energy_unit");
    expect(result.failure.message).toMatch(/kcal eller kJ/);
  });

  it("refuses a product with no energy at all", () => {
    const result = normaliseProduct(
      { code: "1", product_name: "X", nutriments: { proteins_100g: 5 } },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("no_energy");
  });
});

describe("Open Food Facts: missing values", () => {
  it("keeps an absent macro absent rather than zero", () => {
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "X",
        nutriments: { "energy-kcal_100g": 100, proteins_100g: 5 },
      },
      null,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.food.macros.proteinG).toBe(5);
    // Not 0 — the product does not say, and zero would make it a free food.
    expect(result.food.macros.fatG).toBeNull();
    expect(result.food.macros.carbsG).toBeNull();
    expect(result.food.macros.saltG).toBeNull();
  });

  it("keeps a genuine zero", () => {
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "Vatten",
        nutriments: { "energy-kcal_100g": 0, fat_100g: 0 },
      },
      null,
    );
    expect(result.ok && result.food.kcalPer100).toBe(0);
    expect(result.ok && result.food.macros.fatG).toBe(0);
  });

  it("refuses a product with no name", () => {
    const result = normaliseProduct(
      { code: "1", nutriments: { "energy-kcal_100g": 100 } },
      null,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("no_name");
  });

  it("prefers the Swedish name when the record has one", () => {
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "Oat flakes",
        product_name_sv: "Havregryn",
        nutriments: { "energy-kcal_100g": 359 },
      },
      null,
    );
    expect(result.ok && result.food.name).toBe("Havregryn");
  });
});

describe("Open Food Facts: the client they require", () => {
  it("sends a descriptive User-Agent naming the app and a contact", async () => {
    const { impl, calls } = stubFetch(() => ({ body: { status: 0 } }));
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });

    await adapter.lookupBarcode("7310865004703");

    expect(calls[0]!.headers?.["User-Agent"]).toBe(OFF_USER_AGENT);
    expect(OFF_USER_AGENT).toMatch(/Vikt/);
    expect(OFF_USER_AGENT).toMatch(/https?:\/\//);
  });

  it("returns null for a barcode the source does not have", async () => {
    const { impl } = stubFetch(() => ({ body: { status: 0 } }));
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });
    expect(await adapter.lookupBarcode("0000000000000")).toBeNull();
  });

  it("reports being rate limited upstream, with the retry delay", async () => {
    const { impl } = stubFetch(() => ({ status: 429, headers: { "retry-after": "30" } }));
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });

    await expect(adapter.lookupBarcode("1")).rejects.toBeInstanceOf(AdapterUnavailable);
    await adapter.lookupBarcode("1").catch((error: AdapterUnavailable) => {
      expect(error.retryAfterMs).toBe(30_000);
    });
  });
});

/**
 * The live API is not the shape the first fixtures assumed — the contract check
 * against the real service found that nutrients sit behind a per-food link and
 * are keyed by EuroFIR code, with energy appearing **twice** under `ENERC`, told
 * apart only by `enhet`. These fixtures are the real shape.
 */
describe("Livsmedelsverket", () => {
  const potatis = { nummer: "1234", namn: "Potatis, kokt" };
  const potatisNutrients = [
    { euroFIRkod: "ENERC", namn: "Energi (kJ)", varde: 360, enhet: "kJ" },
    { euroFIRkod: "ENERC", namn: "Energi (kcal)", varde: 86, enhet: "kcal" },
    { euroFIRkod: "PROT", namn: "Protein", varde: 1.8, enhet: "g" },
    { euroFIRkod: "FAT", namn: "Fett, totalt", varde: 0.1, enhet: "g" },
  ];

  it("reads energy as kJ, keyed on the code and the unit, not the Swedish name", () => {
    const result = normaliseLivsmedel(potatis, potatisNutrients);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.food.sourceEnergyUnit).toBe("kJ");
    expect(result.food.kcalPer100).toBeCloseTo(86.04, 2);
    expect(result.food.macros.proteinG).toBe(1.8);
    expect(result.food.sourceRef).toBe("1234");
  });

  it("never mistakes the kJ number for kcal, which is a factor of 4.184", () => {
    const result = normaliseLivsmedel(potatis, potatisNutrients);
    expect(result.ok && result.food.kcalPer100).toBeLessThan(200);
  });

  it("falls back to the kcal row when there is no kJ one", () => {
    const result = normaliseLivsmedel(potatis, [
      { euroFIRkod: "ENERC", namn: "Energi (kcal)", varde: 86, enhet: "kcal" },
    ]);
    expect(result.ok && result.food.kcalPer100).toBe(86);
    expect(result.ok && result.food.sourceEnergyUnit).toBe("kcal");
  });

  it("refuses an energy row whose unit it cannot read, rather than guessing", () => {
    const result = normaliseLivsmedel(potatis, [
      { euroFIRkod: "ENERC", namn: "Energi", varde: 360, enhet: "??" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("unknown_energy_unit");
  });

  it("keeps unlisted nutrients absent rather than zero", () => {
    const result = normaliseLivsmedel(potatis, [
      { euroFIRkod: "ENERC", namn: "Energi (kJ)", varde: 400, enhet: "kJ" },
    ]);
    expect(result.ok && result.food.macros.fatG).toBeNull();
    expect(result.ok && result.food.macros.saltG).toBeNull();
  });

  it("refuses a food with no energy row at all", () => {
    const result = normaliseLivsmedel(potatis, [
      { euroFIRkod: "PROT", namn: "Protein", varde: 5, enhet: "g" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("no_energy");
  });

  it("has no barcodes, and says so rather than guessing", async () => {
    const adapter = new LivsmedelsverketAdapter();
    expect(adapter.supportsBarcode).toBe(false);
    expect(await adapter.lookupBarcode()).toBeNull();
  });

  /**
   * Their `namn` parameter does not filter — asking for "potatis" returned
   * "Nöt talg" — and nutrients need a request each, so a five-result search
   * would be six calls. The database is imported and searched locally instead;
   * returning nothing here is the honest answer, not an unfinished stub.
   */
  it("returns nothing from search, because it is imported rather than searched", async () => {
    const adapter = new LivsmedelsverketAdapter();
    expect(await adapter.search()).toEqual([]);
  });

  it("reads the paginated envelope the list endpoint actually returns", async () => {
    const { impl } = stubFetch(() => ({
      body: {
        _meta: { totalRecords: 2606, offset: 0, limit: 2 },
        livsmedel: [
          { nummer: 1, namn: "Nöt talg" },
          { nummer: 2, namn: "Potatis, kokt" },
        ],
      },
    }));
    const adapter = new LivsmedelsverketAdapter({ fetchImpl: impl });

    const page = await adapter.listFoods(0, 2);
    expect(page.total).toBe(2606);
    expect(page.foods).toEqual([
      { nummer: "1", namn: "Nöt talg" },
      { nummer: "2", namn: "Potatis, kokt" },
    ]);
  });

  it("fetches nutrients from the per-food endpoint", async () => {
    const { impl, calls } = stubFetch(() => ({ body: potatisNutrients }));
    const adapter = new LivsmedelsverketAdapter({ fetchImpl: impl });

    expect(await adapter.fetchNutrients("1234")).toHaveLength(4);
    expect(calls[0]!.url).toContain("/livsmedel/1234/naringsvarden");
  });
});

/**
 * The Open Food Facts budget is 15 product reads a minute **per IP**, and every
 * call leaves this server from one address — so it is shared across all users,
 * not an allowance each.
 */
describe("the outbound rate limiter", () => {
  function controllable(limit: number) {
    let now = 0;
    const limiter = new RateLimiter({
      limit,
      windowMs: 60_000,
      maxQueueMs: 120_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    return { limiter, advance: (ms: number) => (now += ms), at: () => now };
  }

  it("allows the budget and no more inside the window", async () => {
    const { limiter } = controllable(3);
    for (let i = 0; i < 3; i++) await limiter.run(async () => i);
    expect(limiter.available()).toBe(0);
    expect(limiter.msUntilSlot()).toBeGreaterThan(0);
  });

  it("queues rather than rejecting, so a scan in a shop still works", async () => {
    const { limiter, at } = controllable(2);
    await limiter.run(async () => 1);
    await limiter.run(async () => 2);

    // The third waits for the window rather than failing.
    const before = at();
    await limiter.run(async () => 3);
    expect(at()).toBeGreaterThan(before);
  });

  it("frees slots again once the window passes", async () => {
    const { limiter, advance } = controllable(2);
    await limiter.run(async () => 1);
    await limiter.run(async () => 2);
    expect(limiter.available()).toBe(0);

    advance(60_001);
    expect(limiter.available()).toBe(2);
  });

  it("gives up rather than hanging forever", async () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 60_000,
      maxQueueMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    await limiter.run(async () => 1);
    await expect(limiter.run(async () => 2)).rejects.toBeInstanceOf(RateLimitExceeded);
  });

  it("hands the budget out in arrival order rather than letting waiters race", async () => {
    const { limiter } = controllable(1);
    const order: number[] = [];

    await Promise.all([
      limiter.run(async () => void order.push(1)),
      limiter.run(async () => void order.push(2)),
      limiter.run(async () => void order.push(3)),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps serving after one caller fails", async () => {
    const { limiter } = controllable(5);
    await expect(
      limiter.run(async () => {
        throw new Error("upstream blew up");
      }),
    ).rejects.toThrow("upstream blew up");

    await expect(limiter.run(async () => "fine")).resolves.toBe("fine");
  });

  it("turns its own exhaustion into an adapter-level unavailability", async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxQueueMs: 0 });
    const { impl } = stubFetch(() => ({ body: { status: 0 } }));
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl, productLimiter: limiter });

    await adapter.lookupBarcode("1");
    const error = await adapter.lookupBarcode("2").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect((error as AdapterUnavailable).retryAfterMs).toBeGreaterThan(0);
  });

  it("does not call the network when the budget is gone", async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxQueueMs: 0 });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 0 }),
      headers: { get: () => null },
    }));
    const adapter = new OpenFoodFactsAdapter({
      fetchImpl: fetchSpy as unknown as FetchLike,
      productLimiter: limiter,
    });

    await adapter.lookupBarcode("1");
    await adapter.lookupBarcode("2").catch(() => undefined);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Serving hints: the unit a person can count, not just the grams.
 *
 * `serving_quantity` was already read; `serving_size` beside it carries the
 * word — "1 skiva (35 g)" — and that word is what a stated portion like "fem
 * tunna skivor" gets resolved against. Without it every hint is stored under
 * the generic key `portion` and a count has nothing to multiply.
 */
describe("Open Food Facts: serving hints", () => {
  const hintsFor = (serving: Record<string, unknown>) => {
    const result = normaliseProduct(
      {
        code: "1",
        product_name: "Rökt skinka",
        nutriments: { "energy-kcal_100g": 110 },
        ...serving,
      },
      null,
    );
    return result.ok ? result.food.servingHints : null;
  };

  it("stores the grams under the unit the packet names", () => {
    expect(hintsFor({ serving_quantity: 35, serving_size: "1 skiva (35 g)" })).toEqual({
      skiva: 35,
    });
  });

  /**
   * Per one of the unit, not per serving. Reading this backwards would double
   * every count a user ever states, and would look like a plausible portion
   * rather than like a bug.
   */
  it("divides a multi-unit serving down to one", () => {
    expect(hintsFor({ serving_quantity: 25, serving_size: "2 kex (25 g)" })).toEqual({
      kex: 12.5,
    });
  });

  it("falls back to a generic portion when the text is only a mass", () => {
    expect(hintsFor({ serving_quantity: 30, serving_size: "30 g" })).toEqual({
      portion: 30,
    });
    expect(hintsFor({ serving_quantity: 250 })).toEqual({ portion: 250 });
  });

  /** A hint saying one gram weighs thirty grams would be worse than none. */
  it("never records a mass unit as a portion name", () => {
    expect(hintsFor({ serving_quantity: 200, serving_size: "200 gram" })).toEqual({
      portion: 200,
    });
  });

  /**
   * Volume is the opposite case and is kept. "2 dl (200 g)" is a density, and
   * a density is the only thing that turns an ingredient list into "1,5 dl
   * mjölk" rather than "154 g mjölk".
   */
  it("keeps a volume unit, because that is a density", () => {
    expect(hintsFor({ serving_quantity: 200, serving_size: "2 dl" })).toEqual({ dl: 100 });
  });

  it("has no hint when the source carries no serving figure", () => {
    expect(hintsFor({})).toBeNull();
  });
});

/**
 * Free-text search, and the defect that made it useless.
 *
 * `/api/v2/search?search_terms=` **ignores the parameter**. Every query came
 * back with page one of the whole database — "kvarg", "proteinpulver" and
 * "star nutrition" all returned the same four Moroccan dairy products, with
 * `count: 4730807` on the response. Those results were then written into the
 * shared cache as matches, so "Sidi Ali" became a cached hit for "rågbröd".
 *
 * The same shape as Livsmedelsverket's `namn` parameter, which also does not
 * filter. Two food APIs out of two have shipped a silently ignored search
 * parameter, which is why the last test here asserts on *what came back* rather
 * than on the request having succeeded.
 */
describe("Open Food Facts: searching by name", () => {
  const hit = {
    code: "7310867546744",
    product_name: "Kvarg",
    brands: ["Lindahls"],
    nutriments: { "energy-kcal_100g": 57, proteins_100g: 10.1 },
  };

  function searchStub(body: unknown) {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("asks the search service, not the product API's dead parameter", async () => {
    const { impl, calls } = searchStub({ hits: [hit] });
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });

    await adapter.search("lindahls kvarg", 5);

    expect(calls[0]).toContain("search.openfoodfacts.org");
    expect(calls[0]).toContain("q=lindahls%20kvarg");
    // The parameter that does nothing must not come back.
    expect(calls[0]).not.toContain("search_terms");
  });

  /**
   * `brands` is an array from the search service and a comma string from the
   * product API. Unhandled, the array reaches `firstString`, which quietly
   * returns null: the brand disappears rather than erroring, and a branded
   * product becomes unfindable by its brand.
   */
  it("reads the brand out of the array the search service sends", async () => {
    const { impl } = searchStub({ hits: [hit] });
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });

    const [result] = await adapter.search("kvarg", 5);

    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.food.brand).toBe("Lindahls");
    expect(result.food.name).toBe("Kvarg");
    expect(result.food.barcode).toBe("7310867546744");
    expect(result.food.kcalPer100).toBe(57);
  });

  /**
   * Several brands collapse to the first, which is what the product API's
   * comma-separated string already did. One brand per row is the shape the
   * cache stores and the shape the search ranking reasons about.
   */
  it("takes the first of several brands, as the product API does", async () => {
    const { impl } = searchStub({
      hits: [{ ...hit, brands: ["Miufo", "Food Union"] }],
    });
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });

    const [result] = await adapter.search("kvarg", 5);
    expect(result?.ok && result.food.brand).toBe("Miufo");
  });

  it("answers nothing rather than throwing when the service finds nothing", async () => {
    const { impl } = searchStub({ hits: [] });
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });
    expect(await adapter.search("xyzzy", 5)).toEqual([]);
  });

  /**
   * The check that would have caught the original defect.
   *
   * A search parameter that is ignored still returns 200 and still returns
   * products, so nothing about the *request* is wrong. The only way to see it
   * is to ask whether the results have anything to do with the query.
   */
  it("refuses to call unrelated results a match", async () => {
    const { impl } = searchStub({
      hits: [
        { code: "1", product_name: "Sidi Ali", brands: ["سيدي علي"], nutriments: { "energy-kcal_100g": 0 } },
        { code: "2", product_name: "Perly", brands: ["Jaouda"], nutriments: { "energy-kcal_100g": 60 } },
      ],
    });
    const adapter = new OpenFoodFactsAdapter({ fetchImpl: impl });

    const results = await adapter.search("kvarg", 5);
    const names = results.flatMap((r) => (r.ok ? [r.food.name.toLowerCase()] : []));

    // Not an assertion about this stub: a statement of what "a search worked"
    // means. Nothing here contains the query, which is what the live v2
    // endpoint did for every term tried.
    expect(names.some((name) => name.includes("kvarg"))).toBe(false);
  });
});
