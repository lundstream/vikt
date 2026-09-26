import { describe, expect, it } from "vitest";
import {
  hasTwoSets,
  parseRecipeAmount,
  parseRecipeLine,
  parseYield,
  ratioChecks,
  recipeSets,
} from "./recipe-photo.js";

/**
 * The line reader (D195), against the two photographs the probe read. The
 * lines are the model's own transcriptions from the final probe, misreadings
 * included ("finskvad", "å 390 g", "vitlökskyftor"), because those are the
 * lines this code will actually be given. Ingredient rows only: a cookbook's
 * running text belongs to its author and is not in this repository.
 */

/** The cookbook page: one pizza, two amount sets. */
const BOOK = [
  "1 pizzaboll, se sidan 110",
  "0,39 g (50 g) mozzarella di bufala DOP, i bitar",
  "20 g (25 g) lardo alt pancetta eller bacon, finskuren",
  "3 g (3,5 g) vitlök, finskvad (ca 1 vitlöksklyfta)",
  "3-5 färsk basilikablad",
  "12 g (15 g) pecorino romano DOP, finriven",
  "3 g + 5 g (3 g + 7 g) olivolja",
];

/** The recipe website, photographed off a screen: four portions, one set. */
const SCREEN = [
  "2 gula lökar",
  "2 vitlökskyftor",
  "500 g nötfärs eller hushållsfärs (ärt- och nötfärs)",
  "1 msk olja",
  "4 msk tomatpuré",
  "1 tsk torkad timjan",
  "1 tsk torkad rosmarin",
  "1 förp krossade tomater (å 390 g)",
  "1 köttbuljongtärning",
  "salt",
  "peppar",
  "6 msk smör (6 msk motsvarar ca 90 g)",
  "6 msk vetemjöl",
  "10 dl mjölk",
  "2 dl riven parmesan",
  "9 torkade lasagneplattor",
];

/** A conversion that knows msk and dl and nothing else, like a food with two hints. */
const convert = (count: number, unit: string) =>
  unit === "msk" ? count * 15 : unit === "dl" ? count * 100 : null;

describe("an amount as printed", () => {
  it("keeps a decimal comma as a decimal, and a misprint as printed", () => {
    expect(parseRecipeAmount("0,39 g")).toMatchObject({ value: 0.39, unit: "g" });
    expect(parseRecipeAmount("3,5 g")).toMatchObject({ value: 3.5, unit: "g" });
  });

  it("adds a sum in one unit, and keeps what was printed", () => {
    expect(parseRecipeAmount("3 g + 5 g")).toMatchObject({ value: 8, unit: "g", sum: true, printed: "3 g + 5 g" });
    expect(parseRecipeAmount("3 g + 7 g")).toMatchObject({ value: 10, unit: "g" });
  });

  it("leaves a range as a range, with no value to use", () => {
    for (const printed of ["3-5", "3–5", "3 – 5"]) {
      expect(parseRecipeAmount(printed)).toMatchObject({ value: null, range: true });
    }
  });

  it("refuses a sum across units rather than adding grams to spoons", () => {
    expect(parseRecipeAmount("1 dl + 20 g")).toMatchObject({ value: null, unit: null });
  });

  it("reads fractions and the long unit names", () => {
    expect(parseRecipeAmount("½ dl")).toMatchObject({ value: 0.5, unit: "dl" });
    expect(parseRecipeAmount("1 liter")).toMatchObject({ value: 1, unit: "l" });
  });
});

describe("a line", () => {
  it("finds both amounts only when the second follows the first", () => {
    const mozzarella = parseRecipeLine(BOOK[1]!);
    expect(mozzarella.amount).toMatchObject({ value: 0.39, unit: "g" });
    expect(mozzarella.second).toMatchObject({ value: 50, unit: "g" });
    expect(mozzarella.name).toBe("mozzarella di bufala DOP");
    expect(mozzarella.note).toBe("i bitar");

    const tomatoes = parseRecipeLine(SCREEN[7]!);
    expect(tomatoes.amount).toMatchObject({ value: 1, unit: "förp" });
    expect(tomatoes.second).toBeNull();
  });

  it("never reads the start of a word as a unit", () => {
    expect(parseRecipeLine("2 gula lökar")).toMatchObject({ amount: { value: 2, unit: null }, name: "gula lökar" });
    expect(parseRecipeLine("3 gröna äpplen")).toMatchObject({ amount: { value: 3, unit: null } });
    expect(parseRecipeLine("9 torkade lasagneplattor").searchName).toBe("torkade lasagneplattor");
  });

  it("searches for the first alternative named, and keeps the others in the line", () => {
    const lardo = parseRecipeLine(BOOK[2]!);
    expect(lardo.searchName).toBe("lardo");
    expect(lardo.printed).toContain("pancetta eller bacon");
    expect(parseRecipeLine(SCREEN[2]!).searchName).toBe("nötfärs");
  });

  it("leaves a cross-reference unsearched", () => {
    const ball = parseRecipeLine(BOOK[0]!);
    expect(ball.reference).toBe(true);
    expect(ball.searchName).toBeNull();
    expect(ball.amount).toMatchObject({ value: 1 });
  });

  it("gives a row with no amount no amount", () => {
    expect(parseRecipeLine("salt")).toMatchObject({ amount: null, second: null, searchName: "salt" });
  });

  it("reads a packet's weight, with the accent the model misread", () => {
    expect(parseRecipeLine("1 förp krossade tomater (à 390 g)").weight).toEqual({ grams: 390, each: true });
    expect(parseRecipeLine(SCREEN[7]!).weight).toEqual({ grams: 390, each: true });
    expect(parseRecipeLine(SCREEN[11]!).weight).toEqual({ grams: 90, each: false });
    expect(parseRecipeLine(BOOK[3]!).weight).toBeNull();
  });
});

describe("the recipe", () => {
  it("counts two sets on the cookbook page and one on the screen", () => {
    expect(hasTwoSets(BOOK.map(parseRecipeLine))).toBe(true);
    expect(hasTwoSets(SCREEN.map(parseRecipeLine))).toBe(false);
  });

  /** The mozzarella row is the test the brief names: 0,39 against 50. */
  it("marks the row whose two amounts disagree with the others", () => {
    const checks = ratioChecks(BOOK.map(parseRecipeLine));
    expect(checks).toEqual([false, true, false, false, false, false, false]);
  });

  it("marks nothing without enough rows to compare", () => {
    const lines = ["20 g (25 g) lardo", "0,39 g (50 g) mozzarella"].map(parseRecipeLine);
    expect(ratioChecks(lines)).toEqual([false, false]);
    expect(ratioChecks(SCREEN.map(parseRecipeLine)).every((check) => !check)).toBe(true);
  });

  it("fills a portion count from portioner, personer and port., and nothing else", () => {
    expect(parseYield("4 portioner")).toEqual({ printed: "4 portioner", portions: 4 });
    expect(parseYield("6 personer").portions).toBe(6);
    expect(parseYield("4 port.").portions).toBe(4);
    expect(parseYield("1 PIZZA")).toEqual({ printed: "1 PIZZA", portions: null });
    expect(parseYield("4–6 portioner").portions).toBeNull();
    // A web recipe prints the time beside the count (D200), after a separator.
    expect(parseYield("4 portioner · 30 min")).toEqual({ printed: "4 portioner · 30 min", portions: 4 });
    expect(parseYield("6 personer | 45 minuter").portions).toBe(6);
    expect(parseYield("4 portioner pizza").portions).toBeNull();
    expect(parseYield(null)).toEqual({ printed: null, portions: null });
  });
});

describe("grams for each set", () => {
  const book = BOOK.map(parseRecipeLine);
  const sets = book.map((line) => recipeSets(line, true, convert));

  it("takes the printed amount in the set asked for, the model choosing neither", () => {
    expect(sets[1]!.map((set) => set.grams)).toEqual([0.39, 50]);
    expect(sets[2]!.map((set) => set.grams)).toEqual([20, 25]);
    expect(sets[3]!.map((set) => set.grams)).toEqual([3, 3.5]);
    expect(sets[5]!.map((set) => set.grams)).toEqual([12, 15]);
  });

  it("uses the sum for a split amount, and says what was printed", () => {
    expect(sets[6]).toEqual([
      { printed: "3 g + 5 g", grams: 8, source: "printed", reason: null },
      { printed: "3 g + 7 g", grams: 10, source: "printed", reason: null },
    ]);
  });

  it("gives a row with one amount that amount in both sets", () => {
    expect(sets[4]!.map((set) => set.printed)).toEqual(["3-5", "3-5"]);
    expect(sets[4]!.map((set) => set.reason)).toEqual(["range", "range"]);
    expect(sets[0]!.map((set) => set.printed)).toEqual(["1", "1"]);
  });

  it("lets the printed weight win over a volume or a count", () => {
    const screen = SCREEN.map(parseRecipeLine);
    const one = (index: number) => recipeSets(screen[index]!, false, convert)[0]!;
    expect(one(7)).toMatchObject({ grams: 390, source: "printed" });
    expect(one(11)).toMatchObject({ grams: 90, source: "printed" });
    expect(one(2)).toMatchObject({ grams: 500, source: "printed" });
    // "3 g" over "ca 1 vitlöksklyfta".
    expect(sets[3]![0]).toMatchObject({ grams: 3, source: "printed" });
  });

  it("converts the units the app converts, and no others", () => {
    const screen = SCREEN.map(parseRecipeLine);
    const one = (index: number) => recipeSets(screen[index]!, false, convert)[0]!;
    expect(one(3)).toMatchObject({ grams: 15, source: "converted" });
    expect(one(13)).toMatchObject({ grams: 1000, source: "converted" });
    expect(one(5)).toMatchObject({ grams: null, reason: "unit" });
    expect(one(0)).toMatchObject({ grams: null, reason: "unit" });
    expect(one(9)).toMatchObject({ grams: null, reason: "none" });
  });

  it("reads one parenthesised weight as the count's weight, not a second size", () => {
    const line = parseRecipeLine("1 förp (400 g) krossade tomater");
    expect(recipeSets(line, false, convert)).toEqual([
      { printed: "1 förp", grams: 400, source: "printed", reason: null },
    ]);
  });
});
