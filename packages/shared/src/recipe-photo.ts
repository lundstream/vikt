import { z } from "zod";
import { normaliseUnit } from "./portions.js";
import { PHOTO_MAX_BASE64 } from "./schemas/llm.js";

/**
 * A recipe's ingredient list, photographed (Phase 14, item 8 of its brief; D195).
 *
 * **The model transcribes lines and this file reads them.** The probe asked the
 * model to split each row into amount, unit, second amount and name, and it
 * read every figure correctly and put them in the wrong fields: the second
 * amount under `unit`, "gula lökar" as a unit. Asked for the line alone it
 * returned every line as printed, both amounts included, three runs out of
 * three. So the split is here, in code that does the same thing every time and
 * that a test can hold, and the model's part is the part it did well.
 *
 * Nothing here estimates. An amount this file cannot turn into grams is null,
 * and the row says "inte än" until a person gives it.
 */

/* ------------------------------------------------------------ the grammar */

/** Units a number can be followed by. A word not listed here begins the name. */
const UNIT_WORDS = [
  "kg", "hg", "g", "mg",
  "liter", "l", "dl", "cl", "ml",
  "msk", "tsk", "krm",
  "st", "förp", "paket", "burk", "burkar", "påse", "påsar", "ask", "askar",
  "klyfta", "klyftor", "skiva", "skivor", "kvist", "kvistar", "knippe",
  "näve", "nypa", "portion", "portioner", "glas", "flaska", "flaskor",
];

const NUM = String.raw`\d+(?:[.,]\d+)?|[½¼¾⅓⅔]|\d+\/\d+`;
const DASH = String.raw`[-–—]`;
// Longest first, so "kg" is not read as "k" plus "g", and never inside a word:
// "3 gröna äpplen" has no unit.
const UNIT = `(?:${[...UNIT_WORDS].sort((a, b) => b.length - a.length).join("|")})\\.?(?![\\p{L}])`;
const TERM = `(?:${NUM})(?:\\s*${DASH}\\s*(?:${NUM}))?(?:\\s*${UNIT})?`;
const AMOUNT = `${TERM}(?:\\s*\\+\\s*${TERM})*`;
const LINE = new RegExp(`^(${AMOUNT})(?:\\s*\\(\\s*(${AMOUNT})\\s*\\))?\\s*(.*)$`, "iu");

const MASS: Record<string, number> = { kg: 1000, hg: 100, g: 1, mg: 0.001 };

const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };

function numberOf(text: string): number {
  const fraction = FRACTIONS[text];
  if (fraction !== undefined) return fraction;
  const slash = text.match(/^(\d+)\/(\d+)$/);
  if (slash) return Number(slash[1]) / Number(slash[2]);
  return Number(text.replace(",", "."));
}

/**
 * One amount as printed: "0,39 g", "3–5", "3 g + 5 g".
 *
 * `value` is the number to use, and null when there is none to use: a range,
 * which a person narrows ("3–5 basilikablad" is not four), or a sum whose
 * terms are in different units. A sum in one unit is its total, with the
 * printed text kept beside it.
 */
export type RecipeAmount = {
  printed: string;
  value: number | null;
  unit: string | null;
  range: boolean;
  sum: boolean;
};

export function parseRecipeAmount(printed: string): RecipeAmount | null {
  const text = printed.trim();
  if (!new RegExp(`^${AMOUNT}$`, "iu").test(text)) return null;

  const terms = text.split("+").map((part) => part.trim());
  let total = 0;
  let range = false;
  const units = new Set<string | null>();

  for (const term of terms) {
    const match = term.match(
      new RegExp(`^(${NUM})(?:\\s*${DASH}\\s*(${NUM}))?(?:\\s*(${UNIT}))?$`, "iu"),
    );
    if (!match) return null;
    if (match[2] !== undefined) range = true;
    units.add(match[3] ? normaliseUnit(match[3]) : null);
    total += numberOf(match[1]!);
  }

  const unit = units.size === 1 ? [...units][0]! : null;
  const value = range || units.size > 1 ? null : Math.round(total * 1000) / 1000;
  return { printed: text, value, unit, range, sum: terms.length > 1 };
}

/**
 * One ingredient line, read.
 *
 * `second` is an amount in parentheses **directly after** the first, which is
 * how a book prints a second size. A parenthesis after the name is not one:
 * "krossade tomater (à 390 g)" says what a packet weighs.
 */
export type RecipeLine = {
  printed: string;
  amount: RecipeAmount | null;
  second: RecipeAmount | null;
  /** Everything after the amounts, up to the first comma outside parentheses. */
  name: string;
  /** What follows that comma: "i bitar", "finskuren". */
  note: string | null;
  /** What to search the food database for, or null for a cross-reference. */
  searchName: string | null;
  /** "se sidan 110": a recipe of its own, which no food row prices. */
  reference: boolean;
  /**
   * A weight printed elsewhere on the line. `each` for "à 390 g", a packet's
   * weight to multiply by the count; otherwise the whole amount's weight,
   * "6 msk (motsvarar ca 90 g)". A printed weight wins over a volume or a
   * count, because it is the book's own figure and a conversion is ours.
   */
  weight: { grams: number; each: boolean } | null;
};

export function parseRecipeLine(printed: string): RecipeLine {
  const text = printed.replace(/\s+/g, " ").trim();
  const match = text.match(LINE);
  const amount = match?.[1] ? parseRecipeAmount(match[1]) : null;
  const second = match?.[2] ? parseRecipeAmount(match[2]) : null;
  const rest = (amount ? match![3]! : text).trim();

  const comma = topLevelComma(rest);
  const name = (comma < 0 ? rest : rest.slice(0, comma)).trim();
  const note = comma < 0 ? null : rest.slice(comma + 1).trim() || null;

  const reference = /\bse\s+sid(?:an|orna)?\s+\d+/iu.test(rest);
  return {
    printed: text,
    amount,
    second,
    name,
    note,
    searchName: reference ? null : searchNameOf(name),
    reference,
    weight: weightIn(rest),
  };
}

function topLevelComma(text: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) return index;
  }
  return -1;
}

/**
 * The first alternative named, without parentheses: "lardo alt pancetta eller
 * bacon" searches for lardo, and the others stay visible in the printed line.
 */
function searchNameOf(name: string): string | null {
  const plain = name.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const first = plain.split(/\s+(?:eller|alt\.?|alternativt)\s+|\s*\/\s*/iu)[0]!.trim();
  return first === "" ? null : first;
}

function weightIn(rest: string): RecipeLine["weight"] {
  // "à 390 g". The probe's model read the accent as "å", so both are accepted.
  const each = rest.match(new RegExp(`(?:^|[\\s(])[àáå]\\s*(${NUM})\\s*(kg|hg|g)(?![\\p{L}])`, "iu"));
  if (each) return { grams: grams(each[1]!, each[2]!), each: true };

  for (const group of rest.matchAll(/\(([^()]*)\)/g)) {
    const total = group[1]!.match(new RegExp(`(${NUM})\\s*(kg|hg|g)(?![\\p{L}])`, "iu"));
    if (total) return { grams: grams(total[1]!, total[2]!), each: false };
  }
  return null;
}

function grams(value: string, unit: string): number {
  return Math.round(numberOf(value) * MASS[unit.toLowerCase()]! * 100) / 100;
}

/* ------------------------------------------------------------- the recipe */

/**
 * Whether the recipe prints two amount sets.
 *
 * Counted from the lines, not asked of the model: across four prompts its own
 * answer to "are there two sets" was wrong for one photograph or the other
 * every time, while the two amounts themselves were in its lines every time.
 * Two rows, because one parenthesis after one amount is a packet weight more
 * often than a second size.
 */
export function hasTwoSets(lines: RecipeLine[]): boolean {
  return lines.filter((line) => line.second !== null).length >= 2;
}

/**
 * Rows to check against the page.
 *
 * With two sets, every row whose two amounts can be compared gives a ratio,
 * second over first; a row whose ratio is off the median by more than a factor
 * of two is marked. It does not stop the row from being used: a book can scale
 * a spice differently from the flour. It says the numbers should be looked at,
 * which for "0,39 g (50 g) mozzarella" is the point. Fewer than three
 * comparable rows have no meaningful median, and nothing is marked.
 */
export function ratioChecks(lines: RecipeLine[]): boolean[] {
  const ratios = lines.map((line) => ratioOf(line.amount, line.second));
  const valid = ratios.filter((ratio): ratio is number => ratio !== null);
  if (valid.length < 3) return lines.map(() => false);

  const sorted = [...valid].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return ratios.map((ratio) => ratio !== null && (ratio / median > 2 || median / ratio > 2));
}

function ratioOf(first: RecipeAmount | null, second: RecipeAmount | null): number | null {
  if (!first || !second || first.value === null || second.value === null) return null;
  if (!(first.value > 0) || !(second.value > 0)) return null;
  const a = first.unit !== null ? MASS[first.unit] : undefined;
  const b = second.unit !== null ? MASS[second.unit] : undefined;
  if (a !== undefined && b !== undefined) return (second.value * b) / (first.value * a);
  if (first.unit === second.unit) return second.value / first.value;
  return null;
}

/**
 * What the recipe says it makes. A number of portions, people or "port." fills
 * the meal's portion count; anything else ("1 PIZZA") is shown as printed and
 * the count is left for the person, because one pizza is not a number of
 * helpings.
 */
export function parseYield(printed: string | null): { printed: string | null; portions: number | null } {
  if (printed === null || printed.trim() === "") return { printed: null, portions: null };
  const text = printed.replace(/\s+/g, " ").trim();
  const match = text.match(
    /^(?:(?:för|till|ger|räcker till)\s+)?(\d+)\s*(?:portioner|portion|personer|person|pers\.?|port\.?)$/iu,
  );
  const portions = match ? Number(match[1]) : null;
  return { printed: text, portions: portions !== null && portions > 0 ? portions : null };
}

/* ---------------------------------------------------------------- grams */

export type RecipeGrams = {
  grams: number | null;
  /** `printed`: the page's own weight. `converted`: a unit through the food's hints. */
  source: "printed" | "converted" | "unknown";
  /** Why there is no figure, when there is none. */
  reason: "none" | "range" | "unit" | null;
};

/**
 * One row's grams for each amount set the recipe prints.
 *
 * `convert` is the app's own conversion for a count and a unit, the same one a
 * photographed plate's amounts go through (`photoAmount` on the server), so a
 * recipe converts exactly the units the rest of the app converts and no other.
 *
 * With two sets, a row that prints one amount ("1 pizzaboll", "3–5
 * basilikablad") has the same amount in both. The line's printed weight
 * belongs to the amount it was printed beside, the first. Without two sets, a
 * weight in parentheses directly after a count ("1 förp (400 g)") is that
 * count's weight, not a second size.
 */
export function recipeSets(
  line: RecipeLine,
  twoSets: boolean,
  convert: (count: number, unit: string) => number | null,
): (RecipeGrams & { printed: string | null })[] {
  let effective = line;
  if (!twoSets && line.second !== null && line.weight === null && isMass(line.second)) {
    effective = { ...line, second: null, weight: { grams: massOf(line.second)!, each: false } };
  }
  const first = { printed: effective.amount?.printed ?? null, ...gramsFor(effective, effective.amount, convert, true) };
  if (!twoSets) return [first];
  const other = effective.second ?? effective.amount;
  return [first, { printed: other?.printed ?? null, ...gramsFor(effective, other, convert, other === effective.amount) }];
}

function isMass(amount: RecipeAmount): boolean {
  return massOf(amount) !== null;
}

function massOf(amount: RecipeAmount): number | null {
  if (amount.value === null || amount.unit === null) return null;
  const factor = MASS[amount.unit];
  return factor === undefined ? null : Math.round(amount.value * factor * 100) / 100;
}

/**
 * The order is the rule: the page's own weight first ("3 g" over "ca 1
 * vitlöksklyfta", "à 390 g" times the count, "motsvarar ca 90 g" over "6 msk"),
 * then nothing for a row with no amount or a range, then the app's conversion,
 * and null when the unit has none.
 */
function gramsFor(
  line: RecipeLine,
  amount: RecipeAmount | null,
  convert: (count: number, unit: string) => number | null,
  whole: boolean,
): RecipeGrams {
  const mass = amount === null ? null : massOf(amount);
  if (mass !== null) return { grams: mass, source: "printed", reason: null };
  if (line.weight?.each && amount !== null && amount.value !== null) {
    return { grams: Math.round(amount.value * line.weight.grams * 100) / 100, source: "printed", reason: null };
  }
  if (line.weight && !line.weight.each && whole) {
    return { grams: line.weight.grams, source: "printed", reason: null };
  }
  if (amount === null) return { grams: null, source: "unknown", reason: "none" };
  if (amount.range) return { grams: null, source: "unknown", reason: "range" };
  if (amount.value === null) return { grams: null, source: "unknown", reason: "unit" };

  const converted = convert(amount.value, amount.unit ?? "st");
  return converted === null
    ? { grams: null, source: "unknown", reason: "unit" }
    : { grams: converted, source: "converted", reason: null };
}

/* ------------------------------------------------------------ the requests */

export const readRecipeRequestSchema = z.object({
  image: z.string().min(32).max(PHOTO_MAX_BASE64),
});
export type ReadRecipeRequest = z.infer<typeof readRecipeRequestSchema>;

export const recipeSetSchema = z.object({
  /** The amount as printed for this set, or null when the line has none. */
  printed: z.string().nullable(),
  grams: z.number().nullable(),
  /** Computed by the server from the food row, never by the model. */
  kcal: z.number().nullable(),
  source: z.enum(["printed", "converted", "unknown"]),
  reason: z.enum(["none", "range", "unit"]).nullable(),
});
export type RecipeSet = z.infer<typeof recipeSetSchema>;

export const recipeRowSchema = z.object({
  /** The line as the model transcribed it, shown beside the proposal. */
  line: z.string(),
  section: z.string().nullable(),
  /** What was searched for: the first alternative the line names. */
  name: z.string(),
  reference: z.boolean(),
  /** "kontrollera mot sidan": its ratio between the sets is off (ratioChecks). */
  check: z.boolean(),
  /** One per amount set; the second only when the recipe prints two. */
  sets: z.array(recipeSetSchema).min(1).max(2),
  match: z
    .object({
      foodItemId: z.string().uuid(),
      name: z.string(),
      brand: z.string().nullable(),
      kcalPer100: z.number(),
      servingHints: z.record(z.number()).nullable(),
    })
    .nullable(),
});
export type RecipeRow = z.infer<typeof recipeRowSchema>;

export const readRecipeResponseSchema = z.discriminatedUnion("available", [
  z.object({
    available: z.literal(true),
    title: z.string().nullable(),
    yield: z.object({ printed: z.string().nullable(), portions: z.number().nullable() }),
    twoSets: z.boolean(),
    rows: z.array(recipeRowSchema),
    model: z.string(),
    ms: z.number().int().min(0),
  }),
  z.object({
    available: z.literal(false),
    reason: z.enum([
      "disabled",
      "not_configured",
      "unreachable",
      "timeout",
      "failed",
      "unusable_output",
      "rate_limited",
    ]),
    retryAfterSeconds: z.number().int().min(1).optional(),
  }),
]);
export type ReadRecipeResponse = z.infer<typeof readRecipeResponseSchema>;
