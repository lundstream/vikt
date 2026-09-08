/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { RecipeSuggestion } from "../../src/components/RecipeSuggestion.js";

afterEach(cleanup);

/**
 * The recipe generator, from the client's side (§6 phase 8).
 *
 * Two properties are worth a test here, and neither is "the component renders".
 *
 * **A switched-off workstation leaves no trace on the screen.** The brief's
 * first rule for the phase is that nothing depends on the layer and its absence
 * carries no error banner. The strongest form of that is the screen looking
 * exactly as it did before the phase existed, which is what the first test
 * asserts.
 *
 * **What gets logged is what is on the screen after the user edited it**, not
 * what the model proposed. The portions arrive as an estimate for one person;
 * changing one and having the original saved anyway would put a number in the
 * intake series that nobody agreed to.
 */

const HEALTH_ON = {
  match: "/llm/health",
  body: { configured: true, reachable: true, models: { small: "s", large: "l" } },
};

const RECIPE = {
  match: "/llm/recipe",
  body: {
    available: true,
    title: "Omelett med spenat",
    steps: ["Hacka spenaten.", "Vispa äggen och stek."],
    items: [
      {
        name: "ägg",
        estimatedGrams: 120,
        confidence: 0.9,
        match: {
          foodItemId: "11111111-1111-4111-8111-111111111111",
          name: "Ägg",
          brand: null,
          kcalPer100: 155,
          kcal: 186,
        },
      },
      { name: "spenat", estimatedGrams: 50, confidence: 0.8, match: null },
    ],
    budget: { kcal: 700, proteinG: 45, carbsG: 60, fatG: 20, approximate: false },
    total: { kcal: 186, complete: false, missing: ["spenat"] },
    model: "l",
    ms: 8000,
  },
};

describe("the recipe generator when the workstation is off", () => {
  it("renders nothing at all", async () => {
    renderRoute(<RecipeSuggestion localDate="2026-09-02" onLogged={() => {}} />, {
      responses: [
        {
          match: "/llm/health",
          body: { configured: true, reachable: false, models: { small: "s", large: "l" } },
        },
      ],
    });

    // Not a disabled button and not a "currently unavailable" message: nothing.
    await waitFor(() => {
      expect(screen.queryByTestId("recipe-have")).toBeNull();
    });
    expect(screen.queryByLabelText(/har jag hemma/i)).toBeNull();
  });
});

describe("the recipe generator when it is up", () => {
  it("shows the budget it worked to, and prices from the database", async () => {
    renderRoute(<RecipeSuggestion localDate="2026-09-02" onLogged={() => {}} />, {
      responses: [HEALTH_ON, RECIPE],
    });

    fireEvent.change(await screen.findByLabelText(/har jag hemma/i), {
      target: { value: "ägg, spenat" },
    });
    fireEvent.click(screen.getByTestId("generate-recipe"));

    const result = await screen.findByTestId("recipe-result");

    // The constraint, so a fitted suggestion is visibly a fitted one.
    expect(result.textContent).toContain("700");
    expect(result.textContent).toContain("Omelett med spenat");

    // Every figure attributed to the database, on the row it belongs to.
    expect(result.textContent).toContain("186 kcal enligt databasen");

    // The unmatched ingredient says so rather than showing a zero.
    expect(result.textContent).toContain("Ingen träff i databasen");
    // D74: the total says it is not the whole dish, and what is outside it is
    // named at the same size as the number rather than in a grey footnote.
    expect(result.textContent).toContain("Minst 186 kcal");
    expect(result.textContent).toContain("Utanför summan: spenat");
  });

  it("logs the portions as the user left them", async () => {
    const posted: unknown[] = [];

    renderRoute(<RecipeSuggestion localDate="2026-09-02" onLogged={() => {}} />, {
      responses: [HEALTH_ON, RECIPE],
      stateful: [
        {
          match: "/llm/parse-food/confirm",
          get: () => ({ entries: [] }),
          post: (body) => posted.push(body),
        },
      ],
    });

    fireEvent.change(await screen.findByLabelText(/har jag hemma/i), {
      target: { value: "ägg, spenat" },
    });
    fireEvent.click(screen.getByTestId("generate-recipe"));
    await screen.findByTestId("recipe-result");

    // The pan held two eggs, not two and a bit.
    const [eggs] = screen.getAllByLabelText(/gram/i);
    fireEvent.change(eggs!, { target: { value: "100" } });

    // The unpriced row has to be given a value before the recipe can be logged
    // (D74). "Nothing" is one of the answers, and is one tap.
    fireEvent.click(screen.getByTestId("recipe-negligible-1"));

    fireEvent.click(screen.getByTestId("log-recipe"));

    await waitFor(() => expect(posted).toHaveLength(1));

    const body = posted[0] as { localDate: string; items: { name: string; grams: number }[] };
    expect(body.localDate).toBe("2026-09-02");
    expect(body.items[0]).toMatchObject({ name: "Ägg", grams: 100 });
    // Kept as a note with its own name and the value the user chose, so the
    // day records that it was eaten rather than that it was worth nothing.
    expect(body.items[1]).toMatchObject({ name: "spenat", grams: 50, kcal: 0 });
  });
});
