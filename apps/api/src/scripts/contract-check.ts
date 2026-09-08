/**
 * Contract check against the **real** upstream food databases.
 *
 *   pnpm --filter api contract:food
 *
 * Every adapter test runs against fixtures, which is right for a unit test and
 * useless against the failure that actually happens: Open Food Facts renames a
 * field, every fixture still passes, and the app starts refusing products in
 * production. This hits the live services for a handful of known items and
 * asserts that the fields the adapters read still exist and still parse.
 *
 * Kept out of `pnpm test` deliberately. It needs the network, it is slow, and it
 * spends the shared rate budget (D30) — a suite that cannot run offline is a
 * suite people stop running. Run it by hand, or on a schedule.
 *
 * A failure names the field that moved, because "adapter returned null" is not
 * something anyone can act on at eight in the morning.
 */
import "../lib/dotenv.js";
import { normaliseProduct, OpenFoodFactsAdapter } from "../food/openfoodfacts.js";
import { LivsmedelsverketAdapter, normaliseLivsmedel } from "../food/livsmedelsverket.js";
import { AdapterUnavailable } from "../food/adapter.js";

/** Long-lived products, chosen because they are unlikely to be delisted. */
const BARCODES = [
  { barcode: "7310865004703", label: "AXA Havregryn" },
  { barcode: "7622210449283", label: "Marabou mjölkchoklad" },
  { barcode: "3017620422003", label: "Nutella" },
];

const SEARCHES = [
  { query: "havregryn", label: "Open Food Facts search" },
  // A branded product, because brand and name together is the phrasing people
  // actually type and the one that matched neither half before D83.
  { query: "lindahls kvarg", label: "Open Food Facts branded search" },
];

/**
 * The EuroFIR codes `normaliseLivsmedel` keys on. Machine identifiers, unlike the
 * Swedish `namn`, which is display text and will be reworded.
 */
const LIVSMEDEL_CODES = [
  ["energy", "ENERC"],
  ["protein", "PROT"],
  ["carbohydrate", "CHO"],
  ["fat", "FAT"],
] as const;

/**
 * Three outcomes, not two. "The service is down" and "a field moved" look the
 * same from here and are nothing alike: one is upstream having a bad hour, the
 * other needs a code change today. Conflating them makes the check cry wolf,
 * and a check that cries wolf stops being run.
 */
type Finding =
  | { kind: "ok"; what: string }
  | { kind: "unavailable"; what: string; detail: string }
  | { kind: "fail"; what: string; detail: string };

const findings: Finding[] = [];
const pass = (what: string) => findings.push({ kind: "ok", what });
const fail = (what: string, detail: string) => findings.push({ kind: "fail", what, detail });
const unavailable = (what: string, detail: string) =>
  findings.push({ kind: "unavailable", what, detail });

/**
 * The fields each adapter reads. Named individually so a failure says which one
 * disappeared rather than that a product "could not be normalised".
 */
const OFF_FIELDS = {
  identity: ["code", "product_name or product_name_sv"],
  energy: ["nutriments['energy-kcal_100g'] or nutriments['energy-kj_100g']"],
  macros: [
    "nutriments['proteins_100g']",
    "nutriments['carbohydrates_100g']",
    "nutriments['fat_100g']",
  ],
};

/** Counted across the whole set, because the interesting failure is collective. */
const off = { fetched: 0, normalised: 0, refusedBadData: 0 };

async function checkOpenFoodFacts(): Promise<void> {
  const adapter = new OpenFoodFactsAdapter();

  for (const { barcode, label } of BARCODES) {
    let raw: Record<string, unknown> | null = null;

    // Fetch the raw payload separately, so a normalisation failure can be
    // attributed to a specific missing field rather than reported as a miss.
    try {
      const response = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${barcode}`,
        { headers: { "User-Agent": "Vikt/0.1 contract-check (+https://github.com/lundstream/vikt)" } },
      );
      const body = (await response.json()) as { status?: number; product?: Record<string, unknown> };
      if (body.status !== 1 || !body.product) {
        fail(`${label} (${barcode})`, "the product is no longer in Open Food Facts");
        continue;
      }
      raw = body.product;
      off.fetched += 1;
    } catch (error) {
      unavailable(`${label} (${barcode})`, `could not reach it: ${(error as Error).message}`);
      continue;
    }

    const nutriments = (raw.nutriments ?? {}) as Record<string, unknown>;

    if (!raw.code) fail(`${label}: code`, `field "code" is missing — ${OFF_FIELDS.identity[0]}`);
    /**
     * The barcode is a parameter, so its **effect** is what gets asserted (D84).
     *
     * A lookup that ignored the path and answered with some other product would
     * pass every check below this line: the payload would be a real product,
     * with real nutriments, and would normalise cleanly. The only thing that
     * distinguishes "the API found what I asked for" from "the API answered" is
     * whether the thing that came back is the thing that was asked for.
     */
    else if (String(raw.code) !== barcode) {
      fail(
        `${label}: identity`,
        `asked for ${barcode} and got ${String(raw.code)} — the barcode in the path is ` +
          `not selecting the product`,
      );
    }
    if (!raw.product_name && !raw.product_name_sv) {
      fail(`${label}: name`, `both "product_name" and "product_name_sv" are missing`);
    }

    const hasKcal = nutriments["energy-kcal_100g"] !== undefined;
    const hasKj = nutriments["energy-kj_100g"] !== undefined;
    const hasGeneric = nutriments["energy_100g"] !== undefined;
    if (!hasKcal && !hasKj && !hasGeneric) {
      fail(
        `${label}: energy`,
        `none of "energy-kcal_100g", "energy-kj_100g" or "energy_100g" is present — ` +
          `available nutriment keys: ${Object.keys(nutriments).slice(0, 12).join(", ")}`,
      );
    }

    for (const field of ["proteins_100g", "carbohydrates_100g", "fat_100g"]) {
      if (nutriments[field] === undefined) {
        // A missing macro is legal data, not a contract break — but if *every*
        // product is missing the same one, the field has probably moved.
        pass(`${label}: ${field} absent (legal — this product does not state it)`);
      }
    }

    // The real test: does the adapter's own normaliser still produce a food?
    const result = normaliseProduct(raw, barcode);
    if (!result.ok) {
      // Refusing one product whose own numbers contradict each other is the
      // adapter working, not a contract break: 7310865004703 really does claim
      // 550 kJ and 100 kcal, and 550 kJ is 131 kcal. Crowdsourced data contains
      // this. A field that has *moved* shows up as every product refusing, which
      // is checked once at the end.
      if (result.failure.reason === "inconsistent_energy") {
        off.refusedBadData += 1;
        pass(`${label}: correctly refused — its own kcal and kJ values disagree`);
        continue;
      }
      fail(
        `${label}: normalisation`,
        `the adapter refused it (${result.failure.reason}). ` +
          `Nutriment keys present: ${Object.keys(nutriments).slice(0, 12).join(", ")}`,
      );
      continue;
    }

    if (!Number.isFinite(result.food.kcalPer100) || result.food.kcalPer100 <= 0) {
      fail(`${label}: kcal`, `parsed to ${result.food.kcalPer100}, which is not a usable energy value`);
      continue;
    }

    // A sanity band. No real per-100 g food is above 950 kcal (pure fat is ~900).
    if (result.food.kcalPer100 > 950) {
      fail(
        `${label}: kcal`,
        `parsed to ${result.food.kcalPer100.toFixed(0)} kcal/100 g, which is impossible — ` +
          `a kJ value is probably being read as kcal`,
      );
      continue;
    }

    off.normalised += 1;
    pass(
      `${label}: ${result.food.name} — ${result.food.kcalPer100.toFixed(0)} kcal/100 g ` +
        `(source unit ${result.food.sourceEnergyUnit})`,
    );
  }

  // The break a per-product check cannot see: individually each refusal looks
  // like bad data, but none of them normalising means a field name changed.
  if (off.normalised === 0 && off.fetched > 0) {
    fail(
      "Open Food Facts",
      `not one of ${off.fetched} fetched products normalised — an energy or name field ` +
        `has moved, most likely "energy-kcal_100g" / "energy-kj_100g"`,
    );
  }

  for (const { query, label } of SEARCHES) {
    try {
      const results = await adapter.search(query, 5);
      const usable = results.filter((result) => result.ok);

      /**
       * Whether the results have anything to do with the query.
       *
       * This check used to assert that search returned *products*, and it
       * passed for as long as `/api/v2/search?search_terms=` had been ignoring
       * its parameter — which is to say, the whole time. The endpoint answered
       * every query with page one of the entire database, five of which
       * normalised perfectly well, and this said "5/5 usable" (D83).
       *
       * A search parameter that is ignored still returns 200 and still returns
       * products. Relevance is the only thing that distinguishes a working
       * search from a broken one, so relevance is what is asserted.
       */
      const relevant = usable.filter(
        (result) =>
          result.ok &&
          `${result.food.brand ?? ""} ${result.food.name}`
            .toLowerCase()
            .includes(query.toLowerCase().split(" ")[0]!),
      );

      if (results.length === 0) {
        fail(label, `search for "${query}" returned nothing at all — the results array may have moved`);
      } else if (usable.length === 0) {
        fail(label, `search returned ${results.length} results but none normalised`);
      } else if (relevant.length === 0) {
        fail(
          label,
          `search for "${query}" returned ${usable.length} usable results and none of them ` +
            `mention it — the query is being ignored, not answered`,
        );
      } else {
        pass(`${label}: ${relevant.length}/${usable.length} relevant`);
      }
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        unavailable(label, error.message);
      } else {
        fail(label, (error as Error).message);
      }
    }
  }
}

async function checkLivsmedelsverket(): Promise<void> {
  const adapter = new LivsmedelsverketAdapter();

  // 1. The list endpoint and its envelope.
  let sample: { nummer: string; namn: string }[] = [];
  try {
    const page = await adapter.listFoods(0, 5);
    if (page.total < 100) {
      fail(
        "Livsmedelsverket: list",
        `_meta.totalRecords is ${page.total}; the database holds about 2600 foods, so the ` +
          `key "_meta.totalRecords" or "livsmedel" has moved`,
      );
      return;
    }
    if (page.foods.length === 0) {
      fail(
        "Livsmedelsverket: list",
        `the "livsmedel" array was empty, or its rows no longer carry "nummer" and "namn"`,
      );
      return;
    }
    /**
     * `offset` and `size` are parameters, so their effect is asserted (D84).
     *
     * The importer walks this endpoint page by page. If `offset` were ignored,
     * every page would be page one: the import would loop over the same five
     * foods forever, or silently import a fraction of the database, and the
     * old check — which asked only whether rows came back — would have called
     * that healthy. This is the same defect Open Food Facts' `search_terms`
     * had, in the endpoint the entire Swedish food table comes from.
     */
    if (page.foods.length > 5) {
      fail(
        "Livsmedelsverket: list",
        `asked for 5 rows and got ${page.foods.length} — the "size" parameter is ignored`,
      );
      return;
    }

    const second = await adapter.listFoods(5, 5);
    const firstIds = page.foods.map((food) => food.nummer).join(",");
    const secondIds = second.foods.map((food) => food.nummer).join(",");
    if (secondIds.length > 0 && firstIds === secondIds) {
      fail(
        "Livsmedelsverket: list",
        `offset 0 and offset 5 returned the same foods (${firstIds}) — the "offset" ` +
          `parameter is ignored, so the importer would never leave page one`,
      );
      return;
    }

    sample = page.foods;
    pass(
      `Livsmedelsverket: list — ${page.total} foods, ${page.foods.length} per page, ` +
        `offset moves the window`,
    );
  } catch (error) {
    if (error instanceof AdapterUnavailable) {
      unavailable("Livsmedelsverket: list", error.message);
    } else {
      fail("Livsmedelsverket: list", (error as Error).message);
    }
    return;
  }

  /**
   * The food id is a parameter too, so its effect is asserted (D84).
   *
   * Two different foods must not return identical nutrients. If the id in the
   * path were ignored, every food in the database would be imported with the
   * first one's numbers — 2 600 rows of the same food under 2 600 names — and
   * every check below would pass, because the codes would all be present and
   * every row would normalise beautifully.
   */
  if (sample.length >= 2) {
    try {
      const [a, b] = [
        await adapter.fetchNutrients(sample[0]!.nummer),
        await adapter.fetchNutrients(sample[1]!.nummer),
      ];
      const shape = (rows: typeof a) =>
        rows.map((row) => `${String(row.euroFIRkod)}:${String(row.varde)}`).join("|");

      if (a.length > 0 && shape(a) === shape(b)) {
        fail(
          "Livsmedelsverket: nutrients",
          `${sample[0]!.namn} and ${sample[1]!.namn} returned identical nutrient values — ` +
            `the food id in the path is not selecting the food`,
        );
      } else {
        pass("Livsmedelsverket: nutrients — the food id selects the food");
      }
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        unavailable("Livsmedelsverket: nutrients", error.message);
      } else {
        fail("Livsmedelsverket: nutrients", (error as Error).message);
      }
    }
  }

  // 3. The nutrient endpoint, and the EuroFIR codes the adapter reads.
  let normalised = 0;
  for (const food of sample.slice(0, 3)) {
    try {
      const nutrients = await adapter.fetchNutrients(food.nummer);
      if (nutrients.length === 0) {
        fail(
          `Livsmedelsverket: ${food.namn}`,
          `/livsmedel/${food.nummer}/naringsvarden returned no rows`,
        );
        continue;
      }

      const codes = new Set(nutrients.map((row) => String(row.euroFIRkod ?? "")));

      // If the key itself is gone, every code reads as "", and a message listing
      // fifteen empty strings names nothing. Say which key vanished, and print
      // the keys a row actually has now.
      if (codes.size === 1 && codes.has("")) {
        fail(
          `Livsmedelsverket: ${food.namn}`,
          `no nutrient row has "euroFIRkod" — the adapter keys every lookup on it. ` +
            `A row now carries: ${Object.keys(nutrients[0] ?? {}).join(", ")}`,
        );
        continue;
      }

      for (const [label, code] of LIVSMEDEL_CODES) {
        if (!codes.has(code)) {
          fail(
            `Livsmedelsverket: ${food.namn}`,
            `EuroFIR code "${code}" (${label}) is absent. Codes present: ` +
              `${[...codes].slice(0, 15).join(", ")}`,
          );
        }
      }

      // Energy appears twice under ENERC, told apart only by `enhet`.
      const energyUnits = nutrients
        .filter((row) => String(row.euroFIRkod ?? "") === "ENERC")
        .map((row) => String(row.enhet ?? "").toLowerCase());
      if (!energyUnits.includes("kj") && !energyUnits.includes("kcal")) {
        fail(
          `Livsmedelsverket: ${food.namn}`,
          `the ENERC rows carry units ${JSON.stringify(energyUnits)}; the adapter needs ` +
            `"kJ" or "kcal" in "enhet" to know which number it is reading`,
        );
        continue;
      }

      const result = normaliseLivsmedel(food, nutrients);
      if (!result.ok) {
        fail(
          `Livsmedelsverket: ${food.namn}`,
          `the adapter refused it (${result.failure.reason})`,
        );
        continue;
      }
      if (result.food.kcalPer100 > 950) {
        fail(
          `Livsmedelsverket: ${food.namn}`,
          `parsed to ${result.food.kcalPer100.toFixed(0)} kcal/100 g, which is impossible — ` +
            `the kJ value is probably being read as kcal`,
        );
        continue;
      }

      normalised += 1;
      pass(
        `Livsmedelsverket: ${result.food.name} — ` +
          `${result.food.kcalPer100.toFixed(0)} kcal/100 g from ${result.food.sourceEnergyUnit}`,
      );
    } catch (error) {
      if (error instanceof AdapterUnavailable) {
        unavailable(`Livsmedelsverket: ${food.namn}`, error.message);
      } else {
        fail(`Livsmedelsverket: ${food.namn}`, (error as Error).message);
      }
    }
  }

  // One food missing a macro is legal data; none of them normalising is a break.
  if (normalised === 0) {
    fail("Livsmedelsverket", "no sampled food normalised — the nutrient contract has moved");
  }
}

process.stdout.write("\nContract check against the live food databases.\n");
process.stdout.write("This spends the shared rate budget; do not run it in a loop.\n\n");

await checkOpenFoodFacts();
await checkLivsmedelsverket();

const failures = findings.filter((finding) => finding.kind === "fail");
const outages = findings.filter((finding) => finding.kind === "unavailable");

const LABEL = { ok: "  ok   ", unavailable: "  down ", fail: "  FAIL " } as const;
for (const finding of findings) {
  process.stdout.write(`${LABEL[finding.kind]} ${finding.what}\n`);
  if (finding.kind !== "ok") process.stdout.write(`        ${finding.detail}\n`);
}

process.stdout.write(
  `\n${findings.length - failures.length - outages.length} ok, ` +
    `${outages.length} unavailable, ${failures.length} failed.\n`,
);

if (outages.length > 0) {
  process.stdout.write(
    "\nUnavailable is upstream having a bad hour, not a contract break, so it does\n" +
      "not fail the run. If it persists for days, the endpoint itself has moved.\n",
  );
}

if (failures.length > 0) {
  process.stdout.write(
    "\nA failure means an upstream field moved. Fix the adapter, then add a fixture\n" +
      "for the new shape so the offline tests cover it too.\n\n",
  );
  process.exit(1);
}

process.stdout.write("\nEvery field the adapters read is still there and still parses.\n\n");
