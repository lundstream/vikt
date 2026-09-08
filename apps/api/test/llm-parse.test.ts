import { describe, expect, it } from "vitest";
import { readParsedFood, PARSE_SYSTEM_PROMPT } from "../src/llm/parse-food.js";
import { describeBudget, readGeneratedRecipe, RECIPE_SYSTEM_PROMPT } from "../src/llm/recipe.js";
import { COACH_PERSONA, NO_PRESCRIPTION } from "../src/llm/prompts/coach.js";
import { isPlausibleMatch } from "../src/services/llm.service.js";

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

  /** §3: there is no failure state in this UI, and the coach is where one would appear. */
  it("forbids the coach from guilt and cheerleading", () => {
    expect(COACH_PERSONA).toMatch(/Aldrig skuld/);
    expect(COACH_PERSONA).toMatch(/Aldrig peppig/);
    expect(COACH_PERSONA).toMatch(/misslyckats/);
  });

  /** §6: it comments on patterns, it never sets targets or prescribes intake. */
  it("forbids the coach from prescribing", () => {
    expect(NO_PRESCRIPTION).toMatch(/aldrig mål/);
    expect(NO_PRESCRIPTION).toMatch(/kaloriintag/);
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
   * The other side of the connector rule. "Kyckling med curry" is chicken;
   * what follows "med" is what has been done to it, not what it belongs to.
   */
  it("accepts a food that has something added to it", () => {
    expect(isPlausibleMatch("kyckling", "Kyckling med curry")).toBe(true);
    expect(isPlausibleMatch("yoghurt", "Yoghurt, naturell")).toBe(true);
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
