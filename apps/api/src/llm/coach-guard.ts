import { FIGURE_UNITS, type CoachFacts, type CoachFigures, type FigureUnit } from "./coach-context.js";
import { isMarkedGeneral } from "./coach-meaning.js";

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
export type RefusalReason =
  | "floor"
  | "rate"
  | "untraceable"
  | "blame"
  | "instruction"
  /** One thing said to affect another, outside a sentence marked as general. */
  | "causal"
  | "empty";

export type GuardVerdict = { ok: true } | { ok: false; reason: RefusalReason; detail: string };

/**
 * How far a stated figure may sit from the app's own before it stops being the
 * same number.
 *
 * Generous enough for honest rounding ("cirka 1 800" for 1 786) and far tighter
 * than the distance to an invented figure. kcal is proportional because the
 * numbers span 1 200 to 3 000; the rest are absolute because they do not.
 */
const TOLERANCE: Record<FigureUnit, number> = {
  /** Proportional in `isTraceable`; this is the floor under it. */
  kcal: 25,
  kg: 0.2,
  kgPerWeek: 0.06,
  percent: 2,
  /** A macro mean of 118 g quoted as "runt 120 g" is the same figure. */
  grams: 3,
  minutes: 5,
  /** Steps are large and always rounded when spoken: "runt 8 000". */
  steps: 400,
  hours: 0.2,
  drinks: 0.5,
  cm: 0.3,
  /**
   * Counts are exact. There is no such thing as "about 5 days" written in
   * digits, and a count that is off by one is a different fact.
   */
  count: 0,
  /** Never reached: a 1 to 5 rating carries no unit for the pattern to find. */
  scale: 0.1,
};

const KCAL_RELATIVE = 0.02;

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

/**
 * Sentences that make a person the subject of a missing figure (D140 addendum).
 *
 * A **words-level** check rather than a numeric one, in the shape D72 used for
 * recipe prose: a match refuses the reply rather than editing it, because a
 * model that ignored this instruction ignored others too.
 *
 * The distinction it enforces: "intaget är inte ifyllt än" describes data,
 * "du har vägt dig fyra gånger utan att logga något intag" describes a person's
 * diligence, and only the first is something this app says. Every live run
 * before the rule existed produced at least one of the second kind in at least
 * one tone, which is why a line in the prompt was not enough.
 *
 * Deliberately narrow, and narrowed again in D155. It looks for a person **and**
 * an absence **and** a logging verb **in the same clause**, or for the words
 * that can only be a reproach — "glömt", "missat", "struntat", "slarvat". A
 * sentence that merely says a figure is missing has no person in it and passes.
 *
 * The clause part is the narrowing, and a live reply is what asked for it:
 *
 *   "Du har loggat mat två dagar den här veckan, med gryta och havregrynsgröt
 *    som exempel, medan rörelse och steg inte är ifyllda än."
 *
 * That is a true sentence about what was logged, followed by a separate clause
 * about what the app does not have, phrased exactly the way the rules ask for.
 * It was refused, because the old pattern let the person, the verb and the
 * negation come from anywhere in the sentence. Commas and semicolons now stop
 * the match, so the negation has to belong to the clause the person is in.
 *
 * The cost is the other direction: "Du har inte, som du vet, loggat något"
 * would now pass. That sentence is vanishingly unlikely from this model and a
 * false refusal is the more expensive error by far — the reader sees the app
 * distrust a true sentence and gets a refusal in place of an answer.
 */
const BLAME = [
  // "du har inte loggat", "du har aldrig fyllt i", "du har inget vägt"
  /\bdu\b[^.!?,;]*\b(inte|aldrig|inget|ingen|inga)\b[^.!?,;]*\b(logg|fyll|väg|registrer|bock)/i,
  // "du ... loggat inget intag alls"
  /\bdu\b[^.!?,;]*\b(logg|fyll|väg|registrer|bock)[^.!?,;]*\b(inte|aldrig|inget|ingen|inga)\b/i,
  // "utan att logga", "utan att fylla i"
  /utan att (logga|fylla|väga|registrera|bocka)/i,
  // Words that cannot be anything but a reproach.
  /\bgl(ö|o)m(t|de|mer|ma)\b/i,
  /\bmissa(t|de|r)\b/i,
  /\bstrunta(t|de|r)\b/i,
  /\bslarva(t|de|r)\b/i,
  /\bborde ha\b/i,
];

/**
 * Words that turn a suggestion into an instruction (D155).
 *
 * A **words-level** check, in the same shape as BLAME above and for the same
 * reason: the rule is about how a sentence is phrased rather than about a
 * number in it, so a numeric check cannot see it at all.
 *
 * COACH_RULES lets the coach offer at most two suggestions per reply, each as an
 * option — "du kan", "om du vill", "ett alternativ är". This is the other half
 * of that rule, and it is the half that is not a request: an accommodating model
 * asked "något jag bör tänka på?" will answer with "du bör", because the
 * question handed it the word.
 *
 * Deliberately narrow. Each pattern needs the modal **and** a person for it to
 * be addressed to, because `ska` is one of the commonest words in Swedish and
 * refusing every sentence with it in would refuse "det ska bli intressant att
 * se nästa vecka". "du kan", "du får" and "du skulle kunna" are not here and
 * must not be: they are the phrasings the rule asks for.
 */
const INSTRUCTION = [
  /\bdu\s+(måste|ska|skall|bör|borde)\b/i,
  /\b(måste|ska|skall|bör|borde)\s+du\b/i,
  /\bman\s+(måste|ska|skall|bör|borde)\b/i,
  /\bdet\s+(är\s+)?viktigt\s+att\s+du\b/i,
  /\bse\s+till\s+att\s+du\b/i,
];

/**
 * One thing affecting another, which this app does not compute (D171).
 *
 * D155 put the rule in the prompt: two series may sit side by side, never
 * joined by a cause, because Samband draws pairs and calculates no relation at
 * all (D34). The live runs since have produced "kan påverka" twice from a model
 * that had been told not to, which is what a prompt-only rule looks like at the
 * margin.
 *
 * So it is a words-level check now, in the same shape as BLAME and INSTRUCTION.
 * Narrow in exactly one way: a sentence carrying one of the sheet's own general
 * markers passes. That is the sentence the app itself writes — "protein hjälper
 * i regel de flesta att behålla muskler" — and refusing the coach for repeating
 * the app's own interpretation would be the check working against the sheet it
 * is there to protect. Without a marker, "det påverkar din energi" is a claim
 * about this person's data, and nothing here computed it.
 */
const CAUSAL = [/\bpåverka(r|s|t|de|n)?\b/i, /\bleder till\b/i];

function causalIn(sentence: string): string | null {
  if (isMarkedGeneral(sentence)) return null;

  for (const pattern of CAUSAL) {
    const found = pattern.exec(sentence);
    if (found) return found[0];
  }

  return null;
}

/**
 * The one instruction this app does want.
 *
 * "Du bör prata med vården" is the sentence D139 built a whole detection path
 * to produce, and refusing the model for arriving at it independently would be
 * the check working against its own purpose. Narrow: the sentence has to name
 * care, not merely be about health.
 */
const CARE = /vård|läkare|doktor|1177/i;

function instructionIn(sentence: string): string | null {
  if (CARE.test(sentence)) return null;

  for (const pattern of INSTRUCTION) {
    const found = pattern.exec(sentence);
    if (found) return found[0];
  }

  return null;
}

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

type Figure = { value: number; unit: FigureUnit; source: string };

/** Parses `1 800`, `1800`, `1,5` and `1 786,4` into a number. */
function toNumber(raw: string): number | null {
  const cleaned = raw.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * The unit words, longest-first inside each family so `kg` is never read as `g`
 * and `kilokalorier` is never read as `kilo`.
 *
 * Followed by a lookahead rather than a word boundary, for two reasons: `%` is
 * not a word character, so a boundary would not fire after it, and "140 grader"
 * must not match the `g` in it. The lookahead refuses any letter after the unit,
 * which is the rule actually meant.
 */
const UNIT_WORDS = [
  "kcal",
  "kilokalorier",
  "kalorier",
  "kilogram",
  "kilon",
  "kilo",
  "kg",
  "procent",
  "%",
  "gram",
  "g",
  "minuter",
  "minut",
  "min",
  "timmar",
  "timme",
  "standardglas",
  "glas",
  "centimeter",
  "cm",
  "steg",
  "dagarna",
  "dagar",
  "dagen",
  "dag",
  "dygn",
  "gånger",
  "gången",
  "gång",
  "passen",
  "pass",
];

/** Which unit a matched word is, before the per-week suffix is read. */
const UNIT_OF: Record<string, FigureUnit> = {
  kcal: "kcal",
  kilokalorier: "kcal",
  kalorier: "kcal",
  kilogram: "kg",
  kilon: "kg",
  kilo: "kg",
  kg: "kg",
  procent: "percent",
  "%": "percent",
  gram: "grams",
  g: "grams",
  minuter: "minutes",
  minut: "minutes",
  min: "minutes",
  timmar: "hours",
  timme: "hours",
  standardglas: "drinks",
  glas: "drinks",
  centimeter: "cm",
  cm: "cm",
  steg: "steps",
  dagarna: "count",
  dagar: "count",
  dagen: "count",
  dag: "count",
  dygn: "count",
  gånger: "count",
  gången: "count",
  gång: "count",
  passen: "count",
  pass: "count",
};

const FIGURE_PATTERN = new RegExp(
  String.raw`(\d[\d\s\u00a0\u202f]*(?:[.,]\d+)?)\s*(` +
    UNIT_WORDS.join("|") +
    String.raw`)(?![a-zA-ZåäöÅÄÖéÉ])`,
  "gi",
);

/** Every figure with a unit in one sentence, with rates told from weights. */
export function figuresIn(sentence: string): Figure[] {
  const found: Figure[] = [];

  for (const match of sentence.matchAll(FIGURE_PATTERN)) {
    const value = toNumber(match[1] ?? "");
    if (value === null) continue;

    const unitWord = (match[2] ?? "").toLowerCase();
    const after = sentence.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 24).toLowerCase();
    const perWeek = /^\s*(i|per|\/)\s*veck/.test(after) || /^\s*\/\s*v/.test(after);

    const unit = UNIT_OF[unitWord] ?? "kcal";
    found.push({
      value,
      unit: unit === "kg" && perWeek ? "kgPerWeek" : unit,
      source: match[0],
    });
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
const COMPARABLE: Record<FigureUnit, FigureUnit[]> = {
  kcal: ["kcal"],
  kg: ["kg", "kgPerWeek"],
  kgPerWeek: ["kgPerWeek", "kg"],
  percent: ["percent"],
  /**
   * The rest vouch only for themselves. They were added with the data sheet
   * (D155) and none of them has the kilogram case's excuse: there is no shorter
   * true way to write a macro mean as a step count.
   */
  grams: ["grams"],
  minutes: ["minutes"],
  steps: ["steps"],
  hours: ["hours"],
  drinks: ["drinks"],
  cm: ["cm"],
  count: ["count"],
  scale: ["scale"],
};

function isTraceable(figure: Figure, figures: CoachFigures): boolean {
  const known = COMPARABLE[figure.unit].flatMap((unit) => figures[unit] ?? []);

  return known.some((value) => {
    const allowed =
      figure.unit === "kcal"
        ? Math.max(TOLERANCE.kcal, Math.abs(value) * KCAL_RELATIVE)
        : TOLERANCE[figure.unit];

    return Math.abs(value - figure.value) <= allowed;
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
  /**
   * The absence rule first, because it needs no figures: a sentence blaming
   * somebody for a gap is refused whether or not it contains a number.
   */
  for (const pattern of BLAME) {
    const found = pattern.exec(sentence);
    if (found) return { ok: false, reason: "blame", detail: found[0].slice(0, 60) };
  }

  /**
   * Then the instruction rule (D155), also before any figure is looked at: a
   * sentence telling somebody what they must do is refused whether or not it
   * names a number, and most of them do not.
   */
  const instruction = instructionIn(sentence);
  if (instruction !== null) {
    return { ok: false, reason: "instruction", detail: instruction };
  }

  /**
   * Then the causal rule (D171), for the same reason: a sentence joining two
   * series with a cause is refused whether or not it names a figure, unless it
   * is marked as general, which is how the sheet's own interpretations read.
   */
  const causal = causalIn(sentence);
  if (causal !== null) {
    return { ok: false, reason: "causal", detail: causal };
  }

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

/**
 * The figures the **question** contained, added to what the reply may quote
 * (D140).
 *
 * Found live: asked "vad händer om jag bara äter 800 kcal om dagen", the neutral
 * tone answered "systemet kommer inte att generera en plan baserad på 800 kcal",
 * and the check refused it for stating a figure the app had not supplied. But
 * the app had not supplied it because **the person had**: repeating somebody's
 * own number back to them is the opposite of inventing one, and a coach that
 * cannot name the thing it is being asked about is a coach that cannot answer
 * the question.
 *
 * This does not loosen the two hard limits. The floor and rate checks do not
 * consult the allowlist at all: "sikta på 800 kcal" is still refused, whoever
 * said 800 first, because what they forbid is an instruction rather than a
 * number.
 */
export function withQuestionFigures(facts: CoachFacts, question: string): CoachFacts {
  const asked = figuresIn(question);
  if (asked.length === 0) return facts;

  // Copied over the unit list rather than field by field, so a unit added to
  // the sheet cannot be silently dropped here (D155).
  const figures = Object.fromEntries(
    FIGURE_UNITS.map((unit) => [unit, [...(facts.figures[unit] ?? [])]]),
  ) as CoachFigures;

  for (const figure of asked) figures[figure.unit].push(figure.value);

  return { ...facts, figures };
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
