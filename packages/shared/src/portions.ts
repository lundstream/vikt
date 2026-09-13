/**
 * Portions: the unit a person actually holds, over the gram the app stores.
 *
 * Grams are the only unit in the system and that is not changing — `food_entries`
 * stores grams, every calculation reads grams, and D44's single definition of a
 * day's intake depends on there being one unit. This module is a **display and
 * input layer** on top of that, and nothing here writes anything.
 *
 * The reason it has to exist is that grams are not how food arrives. Nobody
 * weighs a lemon. Asking a model to guess "fem tunna skivor rökt skinka" in
 * grams pushes a judgement onto the one participant that cannot be corrected
 * and cannot be asked, and asking it to render a recipe ingredient as "citron
 * 50 g" produces an instruction no one can follow at a chopping board.
 *
 * So a portion has two halves and they are kept apart on purpose:
 *
 *  - the **label** — "5 skivor", "1 citron" — which is what the user said or
 *    what the model proposed, and is never authoritative about mass;
 *  - the **grams**, which come from a hint when one exists and from an estimate
 *    when one does not, and which the user always sees and can always overwrite.
 *
 * A hint is `{"skiva": 35}` on the food item: one skiva is 35 grams. Source
 * hints come from the food database where it carries serving data; a user may
 * define their own for any item, and theirs wins, because they know their bread.
 */

/** One food item's portion units, unit name to grams for one of them. */
export type ServingHints = Record<string, number>;

/**
 * A portion as stated, before anything has been looked up.
 *
 * `unit` is kept **as written** — "skivor", not "skiva" — because that is what
 * gets rendered back, and Swedish plural is something a language model does
 * correctly and a suffix rule does not. Normalisation happens only on the
 * lookup side, where nobody reads the result.
 */
export type StatedPortion = { count: number; unit: string };

/**
 * A portion after the hints have been consulted.
 *
 * `source` is the honesty flag and every screen that shows a portion shows it:
 * `hint` means the grams are the food item's own figure multiplied out, and
 * `estimate` means nothing in the database knew, so the number is a guess and
 * says so.
 */
export type ResolvedPortion = {
  portion: StatedPortion | null;
  grams: number;
  source: "hint" | "user_hint" | "estimate";
};

/**
 * Unit names that mean the same thing, for lookup only.
 *
 * Deliberately small and explicit rather than a stemmer. Swedish plural is
 * irregular enough that a suffix rule gets "bit"/"bitar" right and "sked"/
 * "skedar" right and then quietly turns "ris" into "ri". The cost of a missing
 * entry here is a portion resolving as an estimate, which is a visible,
 * correctable outcome; the cost of a wrong stem is the wrong food's mass.
 */
const UNIT_ALIASES: Record<string, string> = {
  st: "st",
  stycken: "st",
  styck: "st",
  stk: "st",
  skivor: "skiva",
  skivan: "skiva",
  bitar: "bit",
  klyftor: "klyfta",
  portioner: "portion",
  paket: "paket",
  paketet: "paket",
  burkar: "burk",
  påsar: "påse",
  nävar: "näve",
  nypor: "nypa",
  matskedar: "msk",
  matsked: "msk",
  tesked: "tsk",
  teskedar: "tsk",
  kryddmått: "krm",
  deciliter: "dl",
  centiliter: "cl",
  milliliter: "ml",
  liter: "l",
  gram: "g",
  kilogram: "kg",
};

/**
 * A unit name reduced to the key a hint is stored under.
 *
 * Lowercased, trimmed, and mapped through the alias table. Anything unrecognised
 * is returned as-is rather than guessed at, so an unknown unit fails to resolve
 * instead of resolving to the wrong thing.
 */
export function normaliseUnit(unit: string): string {
  const trimmed = unit.trim().toLowerCase().replace(/\.$/, "");
  return UNIT_ALIASES[trimmed] ?? trimmed;
}

/**
 * A hint's grams for one of a unit, or null.
 *
 * Checks the user's own hints first. A shared food item's serving figure comes
 * from whoever packaged it; a user's comes from their own kitchen scale, and
 * when the two disagree the kitchen scale is the one standing in the kitchen.
 */
export function hintGrams(
  unit: string,
  hints: ServingHints | null,
  userHints: ServingHints | null = null,
): { grams: number; source: "hint" | "user_hint" } | null {
  const key = normaliseUnit(unit);

  for (const [candidate, source] of [
    [userHints, "user_hint"] as const,
    [hints, "hint"] as const,
  ]) {
    if (!candidate) continue;
    for (const [name, grams] of Object.entries(candidate)) {
      if (normaliseUnit(name) === key && Number.isFinite(grams) && grams > 0) {
        return { grams, source };
      }
    }
  }

  return null;
}

/**
 * The gram figure to save, given what was said and what is known.
 *
 * The estimate is the fallback and never the preference: a hint multiplied by a
 * count is arithmetic on a measured figure, while an estimate is a guess about
 * a photograph nobody took. When both are present the hint wins and the
 * difference is visible on screen, which is the point — a hint that is wrong for
 * this loaf shows up as a number the user disagrees with, rather than as an
 * invisible substitution.
 */
export function resolvePortion(
  portion: StatedPortion | null,
  estimatedGrams: number,
  hints: ServingHints | null,
  userHints: ServingHints | null = null,
): ResolvedPortion {
  if (portion === null || !Number.isFinite(portion.count) || portion.count <= 0) {
    return { portion: null, grams: estimatedGrams, source: "estimate" };
  }

  const hint = hintGrams(portion.unit, hints, userHints);
  if (hint === null) {
    // A stated portion with nothing to resolve it against. The label is still
    // worth keeping: "5 skivor" tells the user what the grams are supposed to
    // be, which is what makes a wrong estimate spottable.
    return { portion, grams: estimatedGrams, source: "estimate" };
  }

  return {
    portion,
    grams: Math.round(portion.count * hint.grams * 10) / 10,
    source: hint.source,
  };
}

/**
 * A portion as one line of text: "5 skivor", "1,5 dl", "2 ägg".
 *
 * Swedish decimal comma, and the unit verbatim. Not pluralised here on purpose:
 * the caller supplies the word that belongs with the count, because "2 skiva"
 * and "2 skivor" is a distinction a rule gets wrong often enough to be worse
 * than useless in an ingredient list someone is reading while cooking.
 */
export function formatPortion(portion: StatedPortion): string {
  const rounded = Math.round(portion.count * 100) / 100;
  const count = Number.isInteger(rounded)
    ? String(rounded)
    : String(rounded).replace(".", ",");
  return `${count} ${portion.unit.trim()}`;
}

/**
 * Everything a food item can be measured in, for a picker.
 *
 * Grams are always in the list and always first: they are the unit the app
 * actually stores, and a portion picker with no way back to grams is a picker
 * that hides the number being saved.
 */
export function portionUnits(
  hints: ServingHints | null,
  userHints: ServingHints | null = null,
): { unit: string; grams: number; own: boolean }[] {
  const seen = new Set<string>();
  const units: { unit: string; grams: number; own: boolean }[] = [];

  for (const [candidate, own] of [
    [userHints, true] as const,
    [hints, false] as const,
  ]) {
    if (!candidate) continue;
    for (const [unit, grams] of Object.entries(candidate)) {
      const key = normaliseUnit(unit);
      if (seen.has(key) || !Number.isFinite(grams) || grams <= 0) continue;
      seen.add(key);
      units.push({ unit, grams, own });
    }
  }

  return units;
}

/* ------------------------------------------- household measures (D85) */

/**
 * Why a built-in table exists at all.
 *
 * `serving_hints` was wired up in D73 and in practice almost nothing has one:
 * Livsmedelsverket publishes no serving data whatsoever, and Open Food Facts
 * carries it inconsistently, so nearly every food falls back to 100 g. That is
 * not a portion, it is a placeholder — and the two things a person can actually
 * do instead are weigh the food, which is often impossible, or estimate grams,
 * which is hard and which the app was quietly asking of them every time.
 *
 * So a food resolves through three layers, in this order:
 *
 *  1. **the last amount the user logged for that item.** 250 g of filmjölk last
 *     time is 250 g this time. The strongest signal there is, because it is not
 *     an equivalence at all: it is what this person actually ate;
 *  2. **their own portion for that item** (D73), set once and reused;
 *  3. **a household measure for the food's category**, from this table.
 *
 * Anything with none of the three falls back to grams and says so.
 *
 * These figures are approximations of standard Swedish household measures, and
 * they are approximations on purpose: a decilitre of milk is about a hundred
 * grams, and pretending to know it is 103.4 would be fabricated precision. The
 * resolved grams are always shown next to the portion and always editable, so a
 * wrong equivalence is visible before it is saved rather than after.
 */
export const FOOD_CATEGORIES = [
  "dairy_liquid",
  "yoghurt",
  "cheese_hard",
  "cold_cut",
  "egg",
  "bread",
  "flour",
  "sugar",
  "grain_dry",
  "oil",
  "butter",
  "potato",
  "vegetable",
  "fruit",
  "nuts",
  "drink",
] as const;

export type FoodCategory = (typeof FOOD_CATEGORIES)[number];

export function isFoodCategory(value: string | null | undefined): value is FoodCategory {
  return value !== null && value !== undefined && (FOOD_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Grams for one of each unit, by category.
 *
 * Volume measures differ by category because density does: a decilitre of flour
 * is 60 g and a decilitre of milk is 100 g, and a table that ignored that would
 * be worse than no table, because it would be confidently wrong in the
 * direction people cook in.
 *
 * `st` is deliberately absent from most categories. "One vegetable" is not a
 * quantity, and offering it would invite a tap that means nothing.
 */
export const HOUSEHOLD_MEASURES: Record<FoodCategory, ServingHints> = {
  dairy_liquid: { dl: 100, msk: 15, tsk: 5, glas: 200 },
  yoghurt: { dl: 105, portion: 200, msk: 16 },
  cheese_hard: { skiva: 15, msk: 10 },
  cold_cut: { skiva: 12 },
  egg: { st: 60 },
  bread: { skiva: 35, st: 35 },
  flour: { dl: 60, msk: 9, tsk: 3 },
  sugar: { dl: 85, msk: 12, tsk: 4 },
  grain_dry: { dl: 80, portion: 75 },
  oil: { dl: 92, msk: 14, tsk: 5 },
  butter: { msk: 14, tsk: 5, skiva: 5 },
  potato: { st: 100, portion: 200 },
  vegetable: { portion: 100, st: 80 },
  fruit: { st: 120 },
  nuts: { dl: 60, msk: 8 },
  drink: { dl: 100, glas: 200, burk: 330, flaska: 500 },
};

/**
 * Every unit the household table knows, plus the two the app stores in.
 *
 * This is the **whole vocabulary an amount may be stated in** (D143). A
 * photograph comes back with amounts like "stor mängd" and "spridd över delar",
 * which are descriptions of a picture and not quantities, and the difference
 * between the two cannot be decided by looking at the words: it is decided by
 * whether the app can turn the words into grams. This list is that boundary,
 * written down once so the prompt can name the units and the parser can refuse
 * everything else.
 *
 * Derived from the table rather than typed out beside it, because a unit added
 * to a category and not to the list would be a unit the model is forbidden to
 * use and the app knows how to resolve.
 */
export const HOUSEHOLD_UNITS: string[] = [
  "g",
  "kg",
  ...[
    ...new Set(
      Object.values(HOUSEHOLD_MEASURES).flatMap((hints) => Object.keys(hints)),
    ),
  ].sort(),
];

/** The household hints for a category, or null when the food has none. */
export function householdHints(category: string | null | undefined): ServingHints | null {
  return isFoodCategory(category) ? HOUSEHOLD_MEASURES[category] : null;
}

/**
 * Where a resolved amount came from, for saying so on screen.
 *
 * `fallback` is the honest admission: nothing knew, so it is 100 g because 100 g
 * is a number, not because it is this food's portion.
 */
export type AmountSource = "last" | "user_hint" | "household" | "hint" | "fallback";

export type ResolvedAmount = { grams: number; source: AmountSource; unit: string | null };

/** The last resort, and named so it is not mistaken for a measurement. */
export const FALLBACK_GRAMS = 100;

/**
 * The amount to put in the grams field before the user touches it.
 *
 * The layers in order, and the first one that answers wins. Note that layer one
 * is not an equivalence: it is what this person last ate of this food, which
 * beats every table ever printed.
 */
export function resolveDefaultAmount(input: {
  lastGrams?: number | null;
  userHints?: ServingHints | null;
  sourceHints?: ServingHints | null;
  category?: string | null;
}): ResolvedAmount {
  const { lastGrams, userHints, sourceHints, category } = input;

  if (typeof lastGrams === "number" && Number.isFinite(lastGrams) && lastGrams > 0) {
    return { grams: lastGrams, source: "last", unit: null };
  }

  const first = (hints: ServingHints | null | undefined) => {
    if (!hints) return null;
    for (const [unit, grams] of Object.entries(hints)) {
      if (Number.isFinite(grams) && grams > 0) return { unit, grams };
    }
    return null;
  };

  const own = first(userHints);
  if (own) return { grams: own.grams, source: "user_hint", unit: own.unit };

  const packet = first(sourceHints);
  if (packet) return { grams: packet.grams, source: "hint", unit: packet.unit };

  const household = first(householdHints(category));
  if (household) {
    return { grams: household.grams, source: "household", unit: household.unit };
  }

  return { grams: FALLBACK_GRAMS, source: "fallback", unit: null };
}

/**
 * Every unit a food can be counted in, across all three layers.
 *
 * Ordered by authority, and de-duplicated by normalised unit, so a user who has
 * defined their own "skiva" sees theirs and not the table's.
 */
export function allPortionUnits(input: {
  userHints?: ServingHints | null;
  sourceHints?: ServingHints | null;
  category?: string | null;
}): { unit: string; grams: number; source: "user_hint" | "hint" | "household" }[] {
  const seen = new Set<string>();
  const units: { unit: string; grams: number; source: "user_hint" | "hint" | "household" }[] = [];

  const layers = [
    [input.userHints, "user_hint"] as const,
    [input.sourceHints, "hint"] as const,
    [householdHints(input.category), "household"] as const,
  ];

  for (const [hints, source] of layers) {
    if (!hints) continue;
    for (const [unit, grams] of Object.entries(hints)) {
      const key = normaliseUnit(unit);
      if (seen.has(key) || !Number.isFinite(grams) || grams <= 0) continue;
      seen.add(key);
      units.push({ unit, grams, source });
    }
  }

  return units;
}
