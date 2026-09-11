import type { CoachFacts, CoachFigures } from "./coach-context.js";

/**
 * What the coach is allowed to say, checked on the reply (D139).
 *
 * §6 phase 8b rule 2 is explicit that the limits are **enforced on the reply and
 * not only in the prompt**, and the reason is worth restating: an accommodating
 * model asked "what if I only ate 800" will answer the question it was asked.
 * A prompt is a request. This is the part that is not.
 *
 * Three checks, in the order they can fire:
 *
 * **Traceable.** Every figure with a unit has to be one the app already holds.
 * `coach-context.ts` collects exactly the numbers it stated, per unit, and a
 * figure outside that set is one the model produced from its own recollection.
 * This is rule 1 ("every figure it states must be traceable to a number the app
 * already holds") and it is also how D5 is enforced here: a calorie count for a
 * banana is not in the context, has never been in the context, and cannot be.
 *
 * **The floor.** An intake figure below the plan's floor, in a sentence that is
 * telling the reader to do something, is refused whatever the prompt said.
 *
 * **The rate.** The same, for a weekly rate above 1 % of bodyweight.
 *
 * The two limits are checked only in prescriptive sentences, and that is a
 * deliberate narrowing rather than a hole: "du åt 1 430 kcal i tisdags" is a
 * true statement about a logged day that happens to be under the floor, and
 * refusing it would make the coach unable to describe the data it was given.
 * What the rule forbids is *stating an intake*, which is an instruction, and
 * instructions have verbs.
 *
 * A refused reply is **not shown and not stored**. The history keeps the
 * refusal, so what happened is visible later without the sentence that caused
 * it being read again with no check in front of it.
 */

/**
 * What this check cannot see, stated here rather than discovered later.
 *
 * It reads **digits**. A model that writes "runt hundra kalorier" has stated a
 * figure this will not catch, and one live reply did exactly that. Spelling a
 * number out is rare in this register, the prompt asks for the given figures,
 * and the result is a vague sentence rather than a fabricated precise one; a
 * Swedish word-number parser would be a large thing to maintain against that.
 *
 * The two hard limits are unaffected. An instruction to eat a particular number
 * of calories is written in digits, or it is not an instruction anybody can
 * follow.
 */
export type RefusalReason = "floor" | "rate" | "untraceable" | "empty";

export type GuardVerdict = { ok: true } | { ok: false; reason: RefusalReason; detail: string };

/**
 * How far a stated figure may sit from the app's own before it stops being the
 * same number.
 *
 * Generous enough for honest rounding ("cirka 1 800" for 1 786) and far tighter
 * than the distance to an invented figure. kcal is proportional because the
 * numbers span 1 200 to 3 000; the rest are absolute because they do not.
 */
const TOLERANCE = {
  kcalRelative: 0.02,
  kcalAbsolute: 25,
  kg: 0.2,
  kgPerWeek: 0.06,
  percent: 2,
} as const;

/**
 * Words that make a sentence an instruction rather than a description.
 *
 * Deliberately short. Every entry is a verb or a verb phrase that puts the
 * reader in the future; none of them appears in a sentence that reports what
 * happened. A longer list would start catching descriptions, and a description
 * being refused is the failure that makes people stop reading a coach.
 */
const PRESCRIPTIVE = [
  "sikta",
  "ät ",
  "äta",
  "bör ",
  "borde",
  "försök",
  "håll dig",
  "ligg på",
  "lägg dig på",
  "gå ner till",
  "dra ner",
  "minska till",
  "öka till",
  "rekommenderar",
  "föreslår",
  "kör på",
  "satsa på",
  "mål bör",
  "målet bör",
];

/** Questions this app does not answer, detected before the model is called. */
const MEDICAL = [
  "sköldkörtel",
  "tyreoidea",
  "medicin",
  "läkemedel",
  "tablett",
  "recept",
  "gravid",
  "graviditet",
  "amning",
  "ätstörning",
  "anorexi",
  "bulimi",
  "hetsätning",
  "diabetes",
  "insulin",
  "blodtryck",
  "blodprov",
  "kolesterol",
  "depression",
  "antidepress",
  "yrsel",
  "svimma",
  "symptom",
  "symtom",
  "diagnos",
  "sjukdom",
  "ont i",
  "smärta",
  "menstruation",
  "mens ",
  "pcos",
  "ibs",
  "celiaki",
  "allergi",
  "operation",
  "kirurg",
  "ozempic",
  "glp-1",
  "semaglutid",
];

/**
 * Whether a question is medical, asked **before** the model sees it.
 *
 * In code rather than in the prompt, because a deferral has to be reliable and
 * a model's willingness to decline is not. The sentence that comes back is the
 * app's own, once, with no paragraph of disclaimer attached: §6 phase 8b asks
 * for exactly one plain sentence, and a lecture is its own kind of unkindness.
 *
 * Keyword matching has the obvious limitation and it is stated rather than
 * hidden: a medical question phrased without any of these words reaches the
 * model. What bounds that case is everything else here — the model has only
 * this app's own aggregates, may state no figure it was not given, and is told
 * in the persona to decline. This check is the floor, not the ceiling.
 */
export function isMedicalQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  return MEDICAL.some((term) => lower.includes(term));
}

/** Splits into sentences, so a check can run as a stream completes one. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

type Figure = { value: number; unit: keyof CoachFigures; source: string };

/** Parses `1 800`, `1800`, `1,5` and `1 786,4` into a number. */
function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const FIGURE_PATTERN =
  /(\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?)\s*(kcal|kalorier|kilokalorier|kilogram|kilon|kilo|kg|procent|%)/gi;

/** Every figure with a unit in one sentence, with rates told from weights. */
export function figuresIn(sentence: string): Figure[] {
  const found: Figure[] = [];

  for (const match of sentence.matchAll(FIGURE_PATTERN)) {
    const value = toNumber(match[1] ?? "");
    if (value === null) continue;

    const unitWord = (match[2] ?? "").toLowerCase();
    const after = sentence.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 24).toLowerCase();
    const perWeek = /^\s*(i|per|\/)\s*veck/.test(after) || /^\s*\/\s*v/.test(after);

    if (unitWord === "kg" || (unitWord.startsWith("kilo") && unitWord !== "kilokalorier")) {
      found.push({ value, unit: perWeek ? "kgPerWeek" : "kg", source: match[0] });
      continue;
    }
    if (unitWord === "procent" || unitWord === "%") {
      found.push({ value, unit: "percent", source: match[0] });
      continue;
    }
    found.push({ value, unit: "kcal", source: match[0] });
  }

  return found;
}

/**
 * Which stored figures a stated one may be checked against.
 *
 * Kilograms are kilograms. The context says "trendvikten har gått ner 1,3 kg"
 * and "det är 0,32 kg i veckan", and a reply that writes the second one without
 * the period is stating the same fact in a shorter way, not inventing a number.
 * A live summary was refused for exactly that, which is a false refusal and the
 * expensive kind: the reader sees the app distrusting a true sentence.
 *
 * What the separation is actually for stays: a calorie figure can never be
 * vouched for by a weight, and the floor and rate checks still read the precise
 * unit, because "1 200 kcal" and "1,2 kg i veckan" are different instructions.
 */
const COMPARABLE: Record<keyof CoachFigures, (keyof CoachFigures)[]> = {
  kcal: ["kcal"],
  kg: ["kg", "kgPerWeek"],
  kgPerWeek: ["kgPerWeek", "kg"],
  percent: ["percent"],
};

function isTraceable(figure: Figure, figures: CoachFigures): boolean {
  const known = COMPARABLE[figure.unit].flatMap((unit) => figures[unit]);

  return known.some((value) => {
    switch (figure.unit) {
      case "kcal":
        return (
          Math.abs(value - figure.value) <=
          Math.max(TOLERANCE.kcalAbsolute, value * TOLERANCE.kcalRelative)
        );
      case "kg":
        return Math.abs(value - figure.value) <= TOLERANCE.kg;
      case "kgPerWeek":
        return Math.abs(value - figure.value) <= TOLERANCE.kgPerWeek;
      case "percent":
        return Math.abs(value - figure.value) <= TOLERANCE.percent;
    }
  });
}

function isPrescriptive(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return PRESCRIPTIVE.some((marker) => lower.includes(marker));
}

/**
 * Checks one sentence.
 *
 * Sentence by sentence rather than on the whole reply, because the answer is
 * streamed: a sentence is released to the reader only once it has passed, so a
 * figure that fails is never rendered and then taken back.
 */
export function checkSentence(sentence: string, facts: CoachFacts): GuardVerdict {
  const prescriptive = isPrescriptive(sentence);

  for (const figure of figuresIn(sentence)) {
    if (prescriptive && figure.unit === "kcal" && figure.value < facts.guardrails.intakeFloorKcal) {
      return {
        ok: false,
        reason: "floor",
        detail: `${figure.source} under golvet ${facts.guardrails.intakeFloorKcal}`,
      };
    }

    if (
      prescriptive &&
      figure.unit === "kgPerWeek" &&
      facts.guardrails.maxRateKgWeek !== null &&
      figure.value > facts.guardrails.maxRateKgWeek + TOLERANCE.kgPerWeek
    ) {
      return {
        ok: false,
        reason: "rate",
        detail: `${figure.source} över taket ${facts.guardrails.maxRateKgWeek.toFixed(2)}`,
      };
    }

    if (!isTraceable(figure, facts.figures)) {
      return { ok: false, reason: "untraceable", detail: figure.source };
    }
  }

  return { ok: true };
}

/** The same check over a whole reply, for the non-streaming paths and tests. */
export function checkReply(reply: string, facts: CoachFacts): GuardVerdict {
  if (reply.trim() === "") return { ok: false, reason: "empty", detail: "" };

  for (const sentence of sentencesOf(reply)) {
    const verdict = checkSentence(sentence, facts);
    if (!verdict.ok) return verdict;
  }

  return { ok: true };
}
