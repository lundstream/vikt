import type { FoodCategory } from "shared";

/**
 * Which household-measure table a food belongs to (D85).
 *
 * Two sources, because the two adapters carry completely different metadata.
 * Open Food Facts publishes `categories_tags`, which is a real taxonomy and is
 * used first. Livsmedelsverket publishes a name and nothing else, so its foods
 * are matched on the name — which is a heuristic, and is treated as one: a
 * miss returns null, the food falls back to grams, and the screen says so.
 *
 * The bar for adding a rule here is that being wrong must be **visible**. Every
 * resolved amount is shown in grams next to its portion and is editable before
 * saving, so a bad category shows up as a number the user disagrees with rather
 * than as a silent substitution. That is what makes a heuristic acceptable here
 * and would not make it acceptable in `calc/`.
 */

/**
 * Word stems that place a Swedish food name in a category.
 *
 * Order matters: the first match wins, so the more specific stems come first.
 * "Gräddfil" is dairy and would also match "fil", which is why the list is
 * ordered rather than a lookup — and why `mjölkchoklad` has to be excluded from
 * `mjölk` explicitly, since a bar of chocolate is not measured in decilitres.
 */
const NAME_RULES: { category: FoodCategory; stems: string[]; unless?: string[] }[] = [
  { category: "egg", stems: ["ägg"], unless: ["äggnudlar", "äggula", "äggvita pulver"] },
  {
    category: "oil",
    stems: ["olja", "rapsolja", "olivolja", "solrosolja"],
  },
  { category: "butter", stems: ["smör", "margarin", "bregott"], unless: ["smörgås", "smörjbar"] },
  {
    category: "cheese_hard",
    stems: ["ost ", "hårdost", "prästost", "herrgård", "cheddar", "parmesan"],
    unless: ["ostkaka", "ostbågar"],
  },
  {
    category: "cold_cut",
    stems: ["skinka", "salami", "kalkonpålägg", "rökt skinka", "pastrami", "leverpastej"],
  },
  {
    category: "bread",
    stems: ["bröd", "limpa", "knäckebröd", "frallа", "fralla", "baguette", "tortilla"],
  },
  { category: "flour", stems: ["mjöl", "vetemjöl", "rågmjöl", "maizena"] },
  { category: "sugar", stems: ["socker", "strösocker", "florsocker"] },
  {
    category: "grain_dry",
    stems: ["ris ", "ris,", "pasta", "spagetti", "makaron", "couscous", "bulgur", "quinoa",
      "havregryn", "gryn", "linser", "bönor torkade"],
  },
  { category: "potato", stems: ["potatis"], unless: ["potatischips", "potatismos pulver"] },
  { category: "nuts", stems: ["mandel", "nöt ", "nötter", "cashew", "valnöt", "hasselnöt", "jordnöt"] },
  {
    category: "yoghurt",
    stems: ["yoghurt", "kvarg", "kesella", "keso", "turkisk yoghurt"],
  },
  {
    category: "dairy_liquid",
    stems: ["mjölk", "filmjölk", "grädde", "vispgrädde", "matlagningsgrädde", "havredryck",
      "sojadryck", "mandeldryck"],
    unless: ["mjölkchoklad", "mjölkpulver"],
  },
  { category: "drink", stems: ["läsk", "saft", "juice", "öl ", "cider", "energidryck", "vatten"] },
  {
    category: "fruit",
    stems: ["äpple", "banan", "päron", "apelsin", "citron", "lime", "persika", "nektarin", "kiwi"],
  },
  {
    category: "vegetable",
    stems: ["tomat", "gurka", "paprika", "morot", "lök", "broccoli", "blomkål", "spenat",
      "sallad", "zucchini", "aubergine"],
  },
];

/** Open Food Facts category tags, most specific first for the same reason. */
const TAG_RULES: { category: FoodCategory; tags: string[] }[] = [
  { category: "egg", tags: ["eggs", "chicken-eggs"] },
  { category: "oil", tags: ["vegetable-oils", "olive-oils", "rapeseed-oils", "oils"] },
  { category: "butter", tags: ["butters", "margarines", "fats"] },
  { category: "cheese_hard", tags: ["hard-cheeses", "cheeses"] },
  { category: "cold_cut", tags: ["hams", "cold-cuts", "prepared-meats", "charcuteries"] },
  { category: "bread", tags: ["breads", "crispbreads", "sandwich-breads", "baguettes"] },
  { category: "flour", tags: ["flours", "wheat-flours"] },
  { category: "sugar", tags: ["sugars", "caster-sugars"] },
  { category: "grain_dry", tags: ["pastas", "rices", "cereal-grains", "legumes", "rolled-oats"] },
  { category: "potato", tags: ["potatoes"] },
  { category: "nuts", tags: ["nuts", "almonds", "walnuts", "peanuts"] },
  { category: "yoghurt", tags: ["yogurts", "fresh-cheeses", "quarks"] },
  { category: "dairy_liquid", tags: ["milks", "creams", "plant-based-milk-alternatives", "dairies"] },
  { category: "drink", tags: ["beverages", "waters", "sodas", "fruit-juices", "beers"] },
  { category: "fruit", tags: ["fruits", "fresh-fruits"] },
  { category: "vegetable", tags: ["vegetables", "fresh-vegetables", "salads"] },
];

/**
 * A category from Open Food Facts' tags, or null.
 *
 * Tags arrive as `en:hard-cheeses`, so the language prefix is stripped before
 * matching. Null is a perfectly good answer and the common one for the long
 * tail of composite products, which have no household measure worth offering.
 */
export function categoryFromTags(tags: unknown): FoodCategory | null {
  if (!Array.isArray(tags)) return null;

  const cleaned = tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.replace(/^[a-z]{2}:/, "").toLowerCase());

  for (const rule of TAG_RULES) {
    if (rule.tags.some((tag) => cleaned.includes(tag))) return rule.category;
  }

  return null;
}

/**
 * A category from a Swedish food name, or null.
 *
 * For Livsmedelsverket, which publishes no taxonomy at all. Matched on a padded,
 * lowercased name so that a stem ending in a space ("ris ") cannot match inside
 * a longer word ("gris", "riskaka").
 */
export function categoryFromName(name: string): FoodCategory | null {
  const haystack = ` ${name.toLowerCase()} `;

  for (const rule of NAME_RULES) {
    if (rule.unless?.some((word) => haystack.includes(word))) continue;
    if (rule.stems.some((stem) => haystack.includes(stem))) return rule.category;
  }

  return null;
}
