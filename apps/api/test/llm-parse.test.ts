import { describe, expect, it } from "vitest";
import { readParsedFood, PARSE_SYSTEM_PROMPT } from "../src/llm/parse-food.js";
import { describeBudget, readGeneratedRecipe, RECIPE_SYSTEM_PROMPT } from "../src/llm/recipe.js";
import { COACH_RULES, TONE_BLOCKS } from "../src/llm/prompts/coach.js";
import { compoundSplits, isPlausibleMatch, matchStrength } from "../src/services/llm.service.js";

/**
 * The rule the whole phase rests on: **the model names things, the database
 * says what they contain** (§6 phase 8).
 *
 * A prompt asking for that is a request. These are the checks that hold when
 * the request is ignored, which for a language model is a matter of when rather
 * than whether. The consequence of getting it wrong is not a wrong number on a
 * screen: an invented calorie count reaches `food_entries`, and from there the
 * §4.2 adaptive maintenance figure, the daily target and both projections. One
 * fabricated number becomes every number.
 */

describe("reading the model's reply", () => {
  it("accepts the agreed shape", () => {
    const result = readParsedFood(
      JSON.stringify({
        items: [
          { name: "ägg", estimatedGrams: 110, confidence: 0.9 },
          { name: "rågbröd", estimatedGrams: 40, confidence: 0.8 },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({ name: "ägg", estimatedGrams: 110, confidence: 0.9 });
    }
  });

  it("accepts finding nothing, which is a real answer", () => {
    const result = readParsedFood(JSON.stringify({ items: [] }));
    expect(result.ok).toBe(true);
  });

  /** The case this file exists for. */
  it("refuses a reply carrying calories", () => {
    const result = readParsedFood(
      JSON.stringify({
        items: [{ name: "ägg", estimatedGrams: 110, confidence: 0.9, kcal: 155 }],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unusable_output");
      expect(result.detail).toContain("kcal");
    }
  });

  it("refuses macros under any of the names a model reaches for", () => {
    for (const key of ["calories", "kalorier", "protein", "kolhydrater", "fett", "energi"]) {
      const result = readParsedFood(
        JSON.stringify({
          items: [{ name: "ägg", estimatedGrams: 110, confidence: 0.9, [key]: 12 }],
        }),
      );
      expect(result.ok, `${key} should be refused`).toBe(false);
    }
  });

  /**
   * A model that decides to be helpful does not put the calories where you
   * looked. It adds a `totals` object beside `items`, or a `nutrition` object
   * inside one, so the scan walks the whole structure.
   */
  it("refuses nutrition hidden anywhere in the reply", () => {
    const beside = readParsedFood(
      JSON.stringify({
        items: [{ name: "ägg", estimatedGrams: 110, confidence: 0.9 }],
        totals: { kcal: 155 },
      }),
    );
    expect(beside.ok).toBe(false);

    const nested = readParsedFood(
      JSON.stringify({
        items: [
          { name: "ägg", estimatedGrams: 110, confidence: 0.9, nutrition: { protein: 12 } },
        ],
      }),
    );
    expect(nested.ok).toBe(false);
  });

  it("refuses an unexpected field even when it is harmless", () => {
    // `.strict()`, so the shape is the contract rather than a minimum. A field
    // nobody asked for is a model doing something nobody designed for.
    const result = readParsedFood(
      JSON.stringify({
        items: [{ name: "ägg", estimatedGrams: 110, confidence: 0.9, note: "två stycken" }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses output that is not JSON at all", () => {
    expect(readParsedFood("Här är dina livsmedel: ägg, bröd").ok).toBe(false);
    expect(readParsedFood("").ok).toBe(false);
  });

  it("refuses a missing or malformed portion", () => {
    expect(readParsedFood(JSON.stringify({ items: [{ name: "ägg" }] })).ok).toBe(false);
    expect(
      readParsedFood(
        JSON.stringify({ items: [{ name: "ägg", estimatedGrams: "110", confidence: 0.9 }] }),
      ).ok,
    ).toBe(false);
  });

  it("refuses an absurd portion rather than logging it", () => {
    expect(
      readParsedFood(
        JSON.stringify({ items: [{ name: "ägg", estimatedGrams: 99999, confidence: 1 }] }),
      ).ok,
    ).toBe(false);
  });
});

/**
 * The prompts are checked for the instructions that carry a rule, not for
 * wording. A rewrite that drops one of these is a rewrite that changes what the
 * feature is allowed to do.
 */
describe("the prompts keep their prohibitions", () => {
  it("tells the parser not to produce nutrition", () => {
    expect(PARSE_SYSTEM_PROMPT).toMatch(/ALDRIG kalorier/);
  });

  it("tells the recipe generator the same, in prose as well as fields", () => {
    expect(RECIPE_SYSTEM_PROMPT).toMatch(/ALDRIG kalorier/);
    expect(RECIPE_SYSTEM_PROMPT).toMatch(/steps/);
  });

  it("gives the parser the shape as an example rather than a description", () => {
    expect(PARSE_SYSTEM_PROMPT).toContain('"estimatedGrams"');
    expect(PARSE_SYSTEM_PROMPT).toContain('"confidence"');
  });

  /**
   * §3: there is no failure state in this UI, and the coach is where one would
   * appear. The prohibition moved into the shared rules when the tones arrived
   * (D140), which is the point of having a shared block: a warmer voice cannot
   * opt out of it.
   */
  it("forbids the coach from guilt, whatever the tone", () => {
    expect(COACH_RULES).toMatch(/Aldrig skuld/);
    expect(COACH_RULES).toMatch(/misslyckats/);
  });

  /** §6: it comments on patterns, it never sets targets or prescribes intake. */
  it("forbids the coach from prescribing", () => {
    expect(COACH_RULES).toMatch(/aldrig mål/);
    expect(COACH_RULES).toMatch(/kaloriintag/);
  });

  /** And no tone block quietly grants back what the rules forbid. */
  it("keeps the tones to tone", () => {
    for (const [tone, block] of Object.entries(TONE_BLOCKS)) {
      expect(block, tone).not.toMatch(/kcal|kalori|mål|takt/i);
    }
  });
});

/**
 * The recipe generator runs its output through the same guard (§6: "output goes
 * through the same parse-and-match path"), plus one the parser does not need.
 */
describe("reading a generated recipe", () => {
  const recipe = (extra: Record<string, unknown> = {}) => ({
    title: "Omelett med spenat",
    steps: ["Hacka spenaten.", "Vispa äggen."],
    items: [{ name: "ägg", estimatedGrams: 120, confidence: 0.9 }],
    ...extra,
  });

  it("accepts a recipe of the agreed shape", () => {
    const result = readGeneratedRecipe(JSON.stringify(recipe()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.title).toBe("Omelett med spenat");
      expect(result.items).toHaveLength(1);
    }
  });

  it("refuses nutrition in the item list, like the parser", () => {
    const result = readGeneratedRecipe(
      JSON.stringify(
        recipe({ items: [{ name: "ägg", estimatedGrams: 120, confidence: 0.9, kcal: 190 }] }),
      ),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a nutrition total bolted onto the recipe", () => {
    const result = readGeneratedRecipe(JSON.stringify(recipe({ nutrition: { kcal: 400 } })));
    expect(result.ok).toBe(false);
  });

  /**
   * The check the key walk cannot make. A recipe has free text in it, and
   * "Stek äggen (ca 300 kcal)" puts an invented figure in front of the user
   * inside the instructions, a few pixels from the app's own correct total.
   */
  it("refuses an energy figure smuggled into the steps", () => {
    for (const step of [
      "Stek äggen, cirka 300 kcal.",
      "Hela rätten blir 450 kalorier.",
      "Servera. Protein: 32 g.",
      "Ger ungefär 25 g protein.",
    ]) {
      const result = readGeneratedRecipe(JSON.stringify(recipe({ steps: [step] })));
      expect(result.ok, `should refuse: ${step}`).toBe(false);
    }
  });

  it("refuses one in the title too", () => {
    const result = readGeneratedRecipe(
      JSON.stringify(recipe({ title: "Omelett, 320 kcal" })),
    );
    expect(result.ok).toBe(false);
  });

  /** The scan must not fire on ordinary cooking prose. */
  it("leaves normal steps alone", () => {
    for (const step of [
      "Stek äggen i smör tills de stannat.",
      "Salta och peppra efter smak.",
      "Servera med 2 skivor bröd.",
      "Grädda i 200 grader i 20 minuter.",
      "Häll i 3 dl vatten.",
    ]) {
      const result = readGeneratedRecipe(JSON.stringify(recipe({ steps: [step] })));
      expect(result.ok, `should accept: ${step}`).toBe(true);
    }
  });

  it("refuses a recipe with no ingredients, which is not a recipe", () => {
    expect(readGeneratedRecipe(JSON.stringify(recipe({ items: [] }))).ok).toBe(false);
  });
});

/**
 * How the day's remaining room is put into words.
 *
 * The hedge is the part that matters: a partly labelled day gives a floor for
 * what has been eaten (D55), so what is left is an upper bound, and the prompt
 * has to say so rather than stating it as a fact.
 */
describe("describing the budget", () => {
  it("lists what is left", () => {
    const text = describeBudget({
      kcal: 700,
      proteinG: 45,
      carbsG: 80,
      fatG: 20,
      approximate: false,
    });
    expect(text).toContain("700 kcal");
    expect(text).toContain("45 g protein");
    expect(text).not.toContain("högst");
  });

  it("says at most, when part of the day is unlabelled", () => {
    const text = describeBudget({
      kcal: 700,
      proteinG: 45,
      carbsG: null,
      fatG: null,
      approximate: true,
    });
    expect(text).toContain("högst");
  });

  it("asks for a normal portion when there is no plan to budget against", () => {
    const text = describeBudget({
      kcal: null,
      proteinG: null,
      carbsG: null,
      fatG: null,
      approximate: false,
    });
    // Not "0 kcal left", which would be a limit the app invented.
    expect(text).toContain("ingen dagsbudget");
    expect(text).not.toContain("0 kcal");
  });
});

/**
 * Which database row a named ingredient is allowed to be priced as.
 *
 * Every case here is one the real model and the real database produced on the
 * first live run, which is why the rules are shaped the way they are rather
 * than being a similarity threshold.
 */
describe("deciding whether a database row is the food that was named", () => {
  it("accepts the same food with a qualifier", () => {
    expect(isPlausibleMatch("ägg", "Ägg rått")).toBe(true);
    expect(isPlausibleMatch("spenat", "Spenat färsk")).toBe(true);
    expect(isPlausibleMatch("kycklingfilé", "Kycklingfilé")).toBe(true);
  });

  it("accepts an inflection of the name", () => {
    expect(isPlausibleMatch("tomat", "Tomater krossade")).toBe(true);
  });

  /** The one that made this function exist. */
  it("refuses a different food that merely sounds like it", () => {
    expect(isPlausibleMatch("kycklingfilé", "Korv kycklingkorv")).toBe(false);
  });

  it("refuses a product the ingredient is only a part of", () => {
    expect(isPlausibleMatch("fetaost", "Grekisk sallad m. fetaost")).toBe(false);
    expect(isPlausibleMatch("ägg", "Pannkaka med ägg och mjölk")).toBe(false);
    // The one the word-count rule alone let through: two words, one of them
    // the food asked for, and the row is a Levantine dish.
    expect(isPlausibleMatch("kyckling", "Fatteh m. kyckling")).toBe(false);
  });

  /**
   * The other side of the connector rule, narrowed by D198. What follows "m."
   * is either how the food was prepared ("Kyckling kokt m. salt" is chicken)
   * or another food, and then the row is a dish: "Kyckling med curry" is a
   * chicken curry, which a bare "kyckling" would only be guessing at.
   */
  it("accepts a food prepared in something, and refuses one made into a dish", () => {
    expect(isPlausibleMatch("kyckling", "Kyckling kokt m. salt")).toBe(true);
    expect(isPlausibleMatch("yoghurt", "Yoghurt, naturell")).toBe(true);
    expect(isPlausibleMatch("kyckling", "Kyckling med curry")).toBe(false);
  });

  it("refuses a longer word that merely starts with a short one", () => {
    // Three letters share a prefix with a great deal that is not rice.
    expect(isPlausibleMatch("ris", "Risotto färdig")).toBe(false);
  });

  it("keeps every word of a multi-word name", () => {
    expect(isPlausibleMatch("keso naturell", "Keso naturell")).toBe(true);
    expect(isPlausibleMatch("keso naturell", "Keso vaniljsmak")).toBe(false);
  });
});

/**
 * The matcher after 1.3.0 (D196). Pairs in both directions, every real name
 * one that exists in the development catalogue; "Lök gul rå" and "Timjan
 * torkad" are the brief's own examples of the name shape.
 */
describe("the matcher: Swedish compounds, inflections and qualifiers (D196)", () => {
  const match = (query: string, name: string) => isPlausibleMatch(query, name);

  /** The three the recipe photo found, and the two in the function's comment. */
  it("refuses the live cases", () => {
    expect(match("mjölk", "Mjölkchoklad")).toBe(false);
    expect(match("peppar", "Pepparrot")).toBe(false);
    expect(match("nötfärs", "Lasagne nötfärs")).toBe(false);
    expect(match("kycklingfilé", "Korv kycklingkorv")).toBe(false);
    expect(match("fetaost", "Grekisk sallad m. fetaost")).toBe(false);
  });

  /** A query that is only the first part of a longer food's name, from the catalogue. */
  it("refuses a compound that merely starts with the word asked for", () => {
    const traps: [string, string][] = [
      ["mjöl", "Mjölk fett 3% berikad"],
      ["potatis", "Potatismjöl"],
      ["ost", "Ostron"],
      ["ägg", "Äggula rå"],
      ["salt", "Saltsill rå"],
      ["peppar", "Pepparkaka"],
      ["lök", "Löksås"],
      ["tomat", "Tomatsås italiensk"],
      ["socker", "Sockerärtor"],
      ["majs", "Majsolja"],
      ["kaffe", "Kaffegrädde fett 12%"],
      ["ris", "Rismjöl vitt"],
    ];
    for (const [query, name] of traps) {
      expect(match(query, name), `${query} / ${name}`).toBe(false);
    }
  });

  /**
   * The same rule the other way, where the second half is not a part of the
   * first: a query compound does not reach its first half. (A part-of compound
   * does, D198, below.)
   */
  it("refuses in the other direction too", () => {
    expect(match("pepparrot", "Peppar")).toBe(false);
    expect(match("mjölkchoklad", "Mjölk fett 3% berikad")).toBe(false);
  });

  it("accepts the plain food the length rule missed or ranked behind a compound", () => {
    expect(match("mjölk", "Mjölk fett 3% berikad")).toBe(true);
    expect(match("gula lökar", "Lök gul")).toBe(true);
    expect(match("gula lökar", "Lök gul rå")).toBe(true);
    expect(match("tomatpuré", "Tomatpuré konc. konserv.")).toBe(true);
    expect(match("krossade tomater", "Tomat krossad konserv. m. lag")).toBe(true);
    expect(match("salt", "Salt m. jod")).toBe(true);
    expect(match("kyckling", "Kyckling kokt m. salt")).toBe(true);
    expect(match("torkad timjan", "Timjan torkad")).toBe(true);
  });

  it("reads an inflection as the same word, both ways, and nothing else", () => {
    expect(match("tomater", "Tomat")).toBe(true);
    expect(match("lök", "Lökar")).toBe(true);
    expect(match("gurkor", "Gurka")).toBe(true);
    expect(match("vitlöksklyfta", "Vitlöksklyftor")).toBe(true);
    expect(match("ris", "Riset")).toBe(true);
    expect(match("ris", "Risotto färdig")).toBe(false);
  });

  /** "Smör osaltat fett ca 80%" was refused for having four words beside one. */
  it("lets numbers, fat content and preparation qualify the food, as many as the name has", () => {
    expect(match("smör", "Smör osaltat fett ca 80%")).toBe(true);
    expect(match("smör", "Smör fett 80%")).toBe(true);
    expect(match("kaffe", "Kaffe bryggt")).toBe(true);
    expect(match("okra", "Okra kokt u. salt")).toBe(true);
    expect(match("yoghurt", "Yoghurt naturell fett 10%")).toBe(true);
  });

  /** A second food word is a cut, a flavour or a variety: a guess, so no. */
  it("refuses a name with any other word in it", () => {
    expect(match("kyckling", "Kyckling mage rå")).toBe(false);
    expect(match("ris", "Ris avorio okokt")).toBe(false);
    expect(match("yoghurt", "Yoghurt vanilje")).toBe(false);
    // "salt" and an ending, in front of the food it describes.
    expect(match("salt", "Salta pinnar")).toBe(false);
  });

  /** These names put the food first; a name led by something else is that thing. */
  it("needs the name to start with one of the words asked for", () => {
    expect(match("bacon", "Gris bacon stekt")).toBe(false);
    expect(match("nötfärs", "Lasagne nötfärs")).toBe(false);
    expect(match("lök gul", "Lök gul")).toBe(true);
  });
});

/**
 * The prompt has to ask for the portion, or the whole resolution path is dead
 * code. It was, on the first live run: the recipe prompt had been updated and
 * the parser's had not, so every row came back "uppskattad vikt".
 */
describe("the parse prompt asks for the portion as stated", () => {
  it("gives the field in the example rather than describing it", () => {
    expect(PARSE_SYSTEM_PROMPT).toContain('"portion"');
    expect(PARSE_SYSTEM_PROMPT).toContain('"count"');
    expect(PARSE_SYSTEM_PROMPT).toContain('"unit"');
  });

  it("says what to do when the text states no amount", () => {
    expect(PARSE_SYSTEM_PROMPT).toMatch(/portion till null/);
  });
});

/**
 * The matcher refined (D198): part-of compounds, compounds written apart,
 * qualifiers without varieties, and a tail that must describe the food. Every
 * real name exists in the development catalogue.
 */
describe("the matcher: parts, split compounds and varieties (D198)", () => {
  const match = (query: string, name: string) => isPlausibleMatch(query, name);

  it("reads a part of a food as the food, and says the part was not named", () => {
    expect(matchStrength("färska basilikablad", "Basilika färsk")).toBe("part");
    expect(matchStrength("vitlöksklyftor", "Vitlök")).toBe("part");
    // Named in the row, so the match is full: "bröstfilé" is the part asked for.
    expect(matchStrength("kycklingbröst", "Kyckling bröstfilé rå u. skinn")).toBe("full");
    expect(matchStrength("kycklingbröst", "Kyckling bröstfilé m. skinn stekt m. salt")).toBe("full");
  });

  it("keeps a part-of compound away from dishes and other foods", () => {
    expect(match("salladblad", "Sallad m. grönsallat gurka tomat u. dressing")).toBe(false);
    expect(match("salladblad", "Salladsost fett 22%")).toBe(false);
    expect(match("vitlöksklyftor", "Vitlökssås fetthalt ca 10%")).toBe(false);
  });

  /** A half that changes what the food is: a concentrate is not broth. */
  it("never reads a form as a part or a half", () => {
    expect(match("köttbuljongtärning", "Köttbuljong ätf.")).toBe(false);
    expect(match("köttbuljongtärning", "Köttbuljong tärning ätf.")).toBe(false);
    expect(match("köttbuljongtärning", "Köttbuljong pulver tärning")).toBe(false);
  });

  it("matches a compound the catalogue writes apart, only with every half", () => {
    expect(matchStrength("nötfärs", "Nöt färs rå fett 10%")).toBe("full");
    expect(match("nötfärs", "Nöt kött rå")).toBe(false);
    expect(match("nötfärs", "Nöt färs stekt tacokryddad hemlagad kryddning")).toBe(false);
    expect(match("pepparrot", "Peppar")).toBe(false);
    expect(compoundSplits("nötfärs")).toContain("nöt färs");
    expect(compoundSplits("köttbuljongtärning")).not.toContain("köttbuljong tärning");
  });

  /** Qualifiers name preparation, state, measure and colour, never a kind. */
  it("refuses a variety, a flavour or a dish word, and a type", () => {
    for (const [query, name] of [
      ["pizza", "Pizza veg. hemlagad"],
      ["pizza", "Pizza orientalisk"],
      ["pizza", "Pizza m. ost restaurang"],
      ["havregrynsgröt", "Havregrynsgröt fullkorn"],
      ["frukostflingor", "Frukostflingor fullkorn typ ringar"],
      ["kvarg", "Kvarg smaksatt m. socker"],
    ] as [string, string][]) {
      expect(match(query, name), `${query} / ${name}`).toBe(false);
    }
  });

  it("still accepts what was right at ff55a74", () => {
    expect(match("mjölk", "Mjölk fett 3% berikad")).toBe(true);
    expect(match("smör", "Smör fett 80%")).toBe(true);
    expect(match("tomatpuré", "Tomatpuré konc. konserv.")).toBe(true);
    expect(match("salt", "Salt m. jod")).toBe(true);
    expect(match("gula lökar", "Lök gul")).toBe(true);
    expect(match("krossade tomater", "Tomat krossad konserv. m. lag")).toBe(true);
    expect(match("kokt potatis", "Potatis kokt m. salt")).toBe(true);
  });
});
