/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RecipeRow } from "shared";
import { ParsedProposal } from "../../src/components/ParsedProposal.js";
import { proposalFor } from "../../src/components/RecipePhotoEntry.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * A recipe's rows in the proposal list (D195): the printed line beside every
 * proposal, the set the person chose, "kontrollera mot sidan", and "inte än"
 * where the page gives no amount the app can use.
 */

const MATCH = {
  foodItemId: "00000000-0000-0000-0000-0000000000f1",
  name: "Mozzarella",
  brand: null,
  kcalPer100: 250,
  servingHints: null,
};

const set = (printed: string | null, grams: number | null, kcal: number | null = null) => ({
  printed,
  grams,
  kcal,
  source: grams === null ? ("unknown" as const) : ("printed" as const),
  reason: grams === null ? ("range" as const) : null,
});

const ROWS: RecipeRow[] = [
  {
    line: "1 pizzaboll, se sidan 110",
    section: null,
    name: "pizzaboll",
    reference: true,
    check: false,
    sets: [set("1", null), set("1", null)],
    match: null,
  },
  {
    line: "0,39 g (50 g) mozzarella di bufala DOP, i bitar",
    section: null,
    name: "mozzarella di bufala DOP",
    reference: false,
    check: true,
    sets: [set("0,39 g", 0.39, 1), set("50 g", 50, 125)],
    match: MATCH,
  },
  {
    line: "3-5 färsk basilikablad",
    section: null,
    name: "färsk basilikablad",
    reference: false,
    check: false,
    sets: [set("3-5", null), set("3-5", null)],
    match: { ...MATCH, name: "Basilika, färsk", foodItemId: "00000000-0000-0000-0000-0000000000f2" },
  },
];

function list(chosen: number) {
  return render(
    <ParsedProposal
      items={ROWS.map((row) => proposalFor(row, chosen))}
      intro={sv["recipePhoto.checkBeforeAdding"]}
      saving={false}
      requireMatch
      onConfirm={async () => {}}
      onCancel={() => {}}
    />,
  );
}

const field = (index: number) =>
  screen.getAllByLabelText(sv["food.grams"])[index] as HTMLInputElement;

afterEach(cleanup);

describe("a recipe's rows", () => {
  it("shows every row's printed line beside its proposal", () => {
    list(0);
    for (const [index, row] of ROWS.entries()) {
      expect(screen.getByTestId(`proposal-printed-${index}`).textContent).toContain(row.line);
    }
  });

  it("takes the first set by default and the other when chosen, the figure as printed", () => {
    list(0);
    expect(field(1).value).toBe("0,39");
    cleanup();
    list(1);
    expect(field(1).value).toBe("50");
  });

  it("puts kontrollera mot sidan on the row that disagrees, and nowhere else", () => {
    list(0);
    expect(screen.getByTestId("proposal-check-1").textContent).toBe(sv["recipePhoto.checkPage"]);
    expect(screen.queryByTestId("proposal-check-0")).toBeNull();
    expect(screen.queryByTestId("proposal-check-2")).toBeNull();
  });

  it("leaves a range empty and says inte än, and the cross-reference cannot be taken", () => {
    list(0);
    expect(field(2).value).toBe("");
    const row = screen.getByTestId("proposal-printed-2").closest("li")!;
    expect(row.textContent).toContain(sv["llm.amountUnknown"]);
    expect(row.textContent!.split(sv["llm.amountUnknown"])).toHaveLength(2);
    expect(screen.getAllByText(sv["meals.cannotTake"])).toHaveLength(1);
    expect(screen.queryByText(sv["llm.noMatch"])).toBeNull();
  });
});
