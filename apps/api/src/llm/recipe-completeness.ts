/**
 * Whether a generated recipe is usable as instructions.
 *
 * The guards in `recipe.ts` protect the *numbers*: they refuse a model that
 * tries to state calories. This file protects the *prose*, and it exists
 * because the first recipes shipped were not wrong so much as unfinished. Real
 * observed output:
 *
 *  - cod placed in an oven dish, with no temperature and no time;
 *  - a sauce whose entire method is "blanda smör, dill och citronsaft";
 *  - an omelette whose steps stop before anything is cooked;
 *  - "dränka pastan", which is `drain` translated as `drown`.
 *
 * None of those would be caught by a schema. All of them are caught by asking
 * four questions of the finished text, which is what this does.
 *
 * A failure here is **not** shown to the user. The caller regenerates once and,
 * if the second attempt fails too, says the model could not produce a complete
 * recipe. Showing a half-recipe with a warning would be worse than showing
 * nothing: someone starts cooking it.
 *
 * Every failure is logged with the rule that caught it, because these rules are
 * a proxy for "a person could cook this" and the only way to tell whether the
 * proxy is any good is to look at what it rejects on real cases.
 */

export type CompletenessFailure = {
  rule:
    | "oven_without_temperature"
    | "oven_without_time"
    | "unused_ingredient"
    | "stops_before_cooked"
    | "seasoning_unstated"
    | "translated_english";
  detail: string;
};

/**
 * Words that mean the oven is on.
 *
 * `ugn` covers the compounds (ugnsform, ugnssäker, in i ugnen) and the standalone
 * word; `grädda` is baking and `tillaga i` on its own is not. Kept narrow: a
 * rule that fires on frying pans would demand a temperature that no recipe
 * states for a hob and would reject every correct recipe in the set.
 */
const OVEN = /\bugn|\bgrädda|\bgratinera|\bvarmluft/i;

/** A temperature: "200 grader", "200°", "175 °C". */
const TEMPERATURE = /\b\d{2,3}\s*(?:°|grader|grad\b)/i;

/**
 * A duration: "20 minuter", "1 timme", "en halvtimme", "10-15 min".
 *
 * Swedish number words are included because a model writing naturally reaches
 * for them, and rejecting "i tjugo minuter" for not using a digit would be the
 * validator failing rather than the recipe.
 */
const NUMBER_WORD =
  "(?:en|ett|två|tre|fyra|fem|sex|sju|åtta|nio|tio|elva|tolv|femton|tjugo|trettio|fyrtio|femtio)";
const TIME = new RegExp(
  String.raw`(?:\d+\s*(?:[-–]\s*\d+\s*)?|${NUMBER_WORD}\s+)(?:min\b|minut|timm|timra|tim\b)|halvtimme|\böver natten\b`,
  "i",
);

/**
 * Verbs that finish a dish.
 *
 * The "stops before cooked" rule needs to know that *something* was cooked, and
 * the honest way to check is to look for a cooking verb anywhere in the steps
 * rather than to guess at the last one. A salad legitimately has none, which is
 * why an absence only counts when the recipe also handled something raw.
 */
const COOKING_VERB =
  /\b(stek|steka|koka|kokar|sjud|fräs|grädda|grilla|ugnsbaka|baka|tillaga|värm|hetta|bryn|pochera|ånga|gratinera|rosta|air ?fry)/i;

/** Ingredients that are unsafe or inedible raw, so a recipe using one must cook. */
const NEEDS_COOKING =
  /\b(kyckling|fläsk|nöt(?:färs|kött)|färs|korv|fisk|torsk|lax|räka|ris\b|pasta|spagetti|makaron|potatis|linser|bönor|ägg|äggen)/i;

/**
 * Steps that mean the food is ready to eat.
 *
 * "Servera" is the strongest signal and the most common; the others cover
 * recipes that end by plating or resting instead.
 */
const FINISHED = /\b(servera|serveras|ät\b|njut|lägg upp|anrätta|låt vila|dra av|smaklig)/i;

/**
 * Seasoning, stated rather than assumed.
 *
 * A weak rule on purpose. It asks only that a savoury recipe mentions salt or
 * seasoning *somewhere*, because "salta och peppra efter smak" is a real step
 * that models drop and cooks notice. It does not try to judge how much.
 */
const SEASONING = /\b(salt|salta|peppar|peppra|krydda|kryddor|smaksätt|soja|buljong)/i;

/** A recipe that needs none: nothing savoury in it. */
const SWEET_ONLY = /\b(gröt|smoothie|pannkak|paj|kaka|efterrätt|yoghurt|müsli|fil\b|bär)/i;

/**
 * Cooking words that only appear when English was translated.
 *
 * "Dränka pastan" is the case that prompted this: `drain` rendered as `dränka`,
 * to drown. A Swedish speaker writing a recipe says "häll av". Each entry is a
 * word that is real Swedish but wrong here, which is precisely why nothing else
 * catches it: the text is fluent and the instruction is nonsense.
 */
const CALQUES: { pattern: RegExp; detail: string }[] = [
  { pattern: /\bdränk[ae]?\b/i, detail: "dränka, sannolikt drain" },
  { pattern: /\bsäsong(?:era|a)\b/i, detail: "säsongera, sannolikt season" },
  { pattern: /\bkasta\s+(?:salladen|pastan|ihop)\b/i, detail: "kasta, sannolikt toss" },
  { pattern: /\bbryt\s+ägg/i, detail: "bryt ägg, sannolikt break eggs" },
  { pattern: /\bkock\s+(?:i|på)\b/i, detail: "kock som verb, sannolikt cook" },
  { pattern: /\bplats\s+(?:i|på)\s+ugnen/i, detail: "plats som verb, sannolikt place" },
  { pattern: /\bkyla\s+ner\s+i\s+kylen\b/i, detail: "kyla ner i kylen, sannolikt chill" },
  { pattern: /\btjäna(?:s)?\s+(?:med|varm)/i, detail: "tjäna, sannolikt serve" },
];

/**
 * Checks a recipe and returns every rule it fails.
 *
 * All of them, not the first: the log is meant to say what is wrong with the
 * prompt across many real cases, and stopping at the first failure would hide
 * the second most common problem behind the most common one.
 */
export function checkCompleteness(recipe: {
  title: string;
  steps: string[];
  items: { name: string }[];
}): CompletenessFailure[] {
  const failures: CompletenessFailure[] = [];
  const steps = recipe.steps;
  const all = steps.join(" ");

  /* 1. An oven step states temperature and time. */
  for (const step of steps) {
    if (!OVEN.test(step)) continue;

    /**
     * The temperature and the time may be in the step that turns the oven on
     * rather than in the one that puts the food in, so the whole recipe is
     * searched. Requiring both in the same sentence would reject "Sätt ugnen
     * på 200 grader." followed by "Baka i 20 minuter.", which is correct and
     * is how people write.
     */
    if (!TEMPERATURE.test(all)) {
      failures.push({ rule: "oven_without_temperature", detail: step });
    }
    if (!TIME.test(all)) {
      failures.push({ rule: "oven_without_time", detail: step });
    }
    break;
  }

  /* 2. Every ingredient is used in at least one step. */
  const prose = all.toLowerCase();
  for (const item of recipe.items) {
    if (!mentioned(item.name, prose)) {
      failures.push({ rule: "unused_ingredient", detail: item.name });
    }
  }

  /* 3. The steps end with the dish finished. */
  const raw = recipe.items.some((item) => NEEDS_COOKING.test(item.name));
  if (raw && !COOKING_VERB.test(all)) {
    failures.push({
      rule: "stops_before_cooked",
      detail: "inget steg tillagar råvarorna",
    });
  } else if (!FINISHED.test(all)) {
    failures.push({
      rule: "stops_before_cooked",
      detail: "sista steget avslutar inte rätten",
    });
  }

  /* 4. Seasoning is stated where it applies. */
  if (!SEASONING.test(all) && !SWEET_ONLY.test(`${recipe.title} ${all}`)) {
    failures.push({ rule: "seasoning_unstated", detail: "ingen krydda nämns" });
  }

  /* 5. The Swedish is Swedish. */
  for (const calque of CALQUES) {
    if (calque.pattern.test(`${recipe.title} ${all}`)) {
      failures.push({ rule: "translated_english", detail: calque.detail });
    }
  }

  return failures;
}

/**
 * Whether an ingredient is referred to in the prose.
 *
 * Swedish makes this harder than a substring test. A step inflects the word
 * ("spenaten", "kycklingen"), and it refers to a compound by its **head**,
 * which is the *last* part: `olivolja` becomes "oljan" and `tomatsås` becomes
 * "såsen". A prefix rule catches the first and misses the second; the tail rule
 * below catches the second.
 *
 * Deliberately generous. A false "unused" rejects a good recipe and costs a
 * regeneration, and this is the rule most likely to fire on ordinary writing.
 */
function mentioned(name: string, prose: string): boolean {
  const wordsOf = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-zà-öø-ÿ0-9]+/i)
      .filter((word) => word.length >= 3);

  const ingredient = wordsOf(name);
  const written = wordsOf(prose);

  return ingredient.some((word) =>
    written.some((used) => {
      // "spenat" / "spenaten", "kycklingfilé" / "kycklingen".
      if (sharedPrefix(word, used) >= 4) return true;
      // "olivolja" / "oljan": the head of the compound, inflected.
      if (used.length >= 4 && word.includes(used.slice(0, 4))) return true;
      if (word.length >= 4 && used.includes(word.slice(0, 4))) return true;
      // "tomatsås" / "såsen": a three-letter head is still a head.
      if (word.endsWith(used.slice(0, 3))) return true;
      return used.startsWith(word);
    }),
  );
}

function sharedPrefix(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}
