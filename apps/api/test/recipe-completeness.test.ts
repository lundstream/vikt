import { describe, expect, it } from "vitest";
import { checkCompleteness } from "../src/llm/recipe-completeness.js";

/**
 * Every case in this file is either a recipe the real model actually produced
 * or a correct recipe that must not be rejected.
 *
 * The second half matters as much as the first. These rules are a proxy for "a
 * person could cook this", and a proxy that rejects good output costs a
 * regeneration every time and eventually a feature that says it cannot manage.
 */

const recipe = (over: Partial<Parameters<typeof checkCompleteness>[0]> = {}) => ({
  title: "Stekt torsk med potatis",
  steps: [
    "Skala och koka potatisen i saltat vatten i 20 minuter.",
    "Stek torsken i smör på medelvärme tills den är genomstekt.",
    "Salta och peppra.",
    "Servera med potatisen.",
  ],
  items: [{ name: "torsk" }, { name: "potatis" }, { name: "smör" }],
  ...over,
});

const rules = (input: Parameters<typeof checkCompleteness>[0]) =>
  checkCompleteness(input).map((failure) => failure.rule);

describe("a complete recipe", () => {
  it("passes", () => {
    expect(checkCompleteness(recipe())).toEqual([]);
  });

  /** A salad cooks nothing, and must not be told it stopped before cooking. */
  it("passes without a cooking step when nothing needs cooking", () => {
    expect(
      rules({
        title: "Tomatsallad",
        steps: ["Skiva tomaterna.", "Ringla över olja och salta.", "Servera genast."],
        items: [{ name: "tomat" }, { name: "olivolja" }],
      }),
    ).toEqual([]);
  });

  /** Porridge needs no seasoning rule applied to it. */
  it("does not demand seasoning in something sweet", () => {
    expect(
      rules({
        title: "Havregröt med banan",
        steps: [
          "Koka upp mjölken.",
          "Tillsätt havregrynen och låt puttra i fem minuter.",
          "Skiva bananen över gröten och servera.",
        ],
        items: [{ name: "havregryn" }, { name: "mjölk" }, { name: "banan" }],
      }),
    ).toEqual([]);
  });

  /**
   * The oven's temperature and time may live in the step that turns it on
   * rather than the one that puts the food in. That is how people write.
   */
  it("accepts a temperature stated in an earlier step than the oven step", () => {
    expect(
      rules({
        title: "Ugnsbakad lax",
        steps: [
          "Sätt ugnen på 200 grader.",
          "Salta laxen och lägg den i en ugnsform.",
          "Baka i 15 minuter.",
          "Servera.",
        ],
        items: [{ name: "lax" }],
      }),
    ).toEqual([]);
  });
});

/** The four observed failures, one test each. */
describe("the recipes that prompted this", () => {
  it("catches an oven dish with no temperature and no time", () => {
    const failures = rules({
      title: "Torsk i ugn",
      steps: [
        "Skölj torsken och lägg den i en ugnsform.",
        "Krydda med salt och peppar.",
        "Servera med potatis.",
      ],
      items: [{ name: "torsk" }, { name: "potatis" }],
    });

    expect(failures).toContain("oven_without_temperature");
    expect(failures).toContain("oven_without_time");
  });

  it("catches an ingredient no step uses", () => {
    const failures = checkCompleteness(
      recipe({ items: [{ name: "torsk" }, { name: "potatis" }, { name: "dill" }] }),
    );

    expect(failures.map((f) => f.rule)).toContain("unused_ingredient");
    expect(failures.find((f) => f.rule === "unused_ingredient")?.detail).toBe("dill");
  });

  it("catches steps that stop before the food is cooked", () => {
    // The omelette that never reached the pan.
    expect(
      rules({
        title: "Omelett med spenat",
        steps: ["Hacka spenaten grovt.", "Vispa äggen med salt och peppar."],
        items: [{ name: "ägg" }, { name: "spenat" }],
      }),
    ).toContain("stops_before_cooked");
  });

  it("catches a recipe that never says it is finished", () => {
    expect(
      rules({
        title: "Stekt torsk",
        steps: ["Salta torsken.", "Stek den i smör i fem minuter."],
        items: [{ name: "torsk" }, { name: "smör" }],
      }),
    ).toContain("stops_before_cooked");
  });

  it("catches seasoning that was assumed rather than stated", () => {
    expect(
      rules({
        title: "Stekt torsk",
        steps: ["Stek torsken i smör i fem minuter.", "Servera."],
        items: [{ name: "torsk" }, { name: "smör" }],
      }),
    ).toContain("seasoning_unstated");
  });

  /**
   * "Dränka pastan" is `drain` translated as `drown`. It is fluent Swedish and
   * a nonsense instruction, which is exactly why no other check sees it.
   */
  it("catches English that has been translated word by word", () => {
    const failures = checkCompleteness({
      title: "Pasta med tomatsås",
      steps: [
        "Koka pastan i saltat vatten i tio minuter.",
        "Dränka pastan och blanda med såsen.",
        "Servera.",
      ],
      items: [{ name: "pasta" }, { name: "tomatsås" }],
    });

    expect(failures.map((f) => f.rule)).toContain("translated_english");
    expect(failures.find((f) => f.rule === "translated_english")?.detail).toContain("drain");
  });
});

describe("how failures are reported", () => {
  /**
   * All of them, not the first. The log is meant to say what is wrong with the
   * prompt across many real cases, and stopping early hides the second most
   * common problem behind the most common one.
   */
  it("returns every rule that failed", () => {
    const failures = rules({
      title: "Torsk",
      steps: ["Lägg torsken i en ugnsform."],
      items: [{ name: "torsk" }, { name: "citron" }],
    });

    expect(new Set(failures)).toEqual(
      new Set([
        "oven_without_temperature",
        "oven_without_time",
        "unused_ingredient",
        "stops_before_cooked",
        "seasoning_unstated",
      ]),
    );
  });

  /** An inflected mention counts. "Spenaten" is the spenat. */
  it("does not call an ingredient unused because the step inflected it", () => {
    expect(
      rules({
        title: "Omelett",
        steps: [
          "Hacka spenaten och riv osten.",
          "Stek omeletten i smör i fem minuter.",
          "Salta och servera.",
        ],
        items: [{ name: "spenat" }, { name: "ost" }, { name: "smör" }],
      }),
    ).toEqual([]);
  });

  /** A longer database name is referred to by part of itself. */
  it("matches an ingredient by its stem", () => {
    expect(
      rules({
        title: "Kyckling i ugn",
        steps: [
          "Sätt ugnen på 200 grader.",
          "Salta kycklingen och lägg den i formen.",
          "Baka i 25 minuter och servera.",
        ],
        items: [{ name: "kycklingfilé" }],
      }),
    ).toEqual([]);
  });
});
