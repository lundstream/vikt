/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { FoodMatch, Meal } from "shared";
import { mealNutrition } from "shared";
import { renderRoute } from "./harness.js";
import { Meals } from "../../src/routes/Meals.js";
import { ParsedProposal } from "../../src/components/ParsedProposal.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * Måltider (Phase 14, D187): the list, the sheet, and "spara som måltid".
 */

const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "test@example.test",
  displayName: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  profile: {
    heightCm: 180,
    birthDate: null,
    sex: "unspecified",
    timezone: "Europe/Stockholm",
    locale: "sv-SE",
    activityFactor: 1.35,
    addExerciseToTarget: false,
    soberAssumeUnloggedDry: false,
    lastDrinkOn: null,
    macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
  },
};

const MINCE = { kcalPer100: 200, proteinPer100: 20, carbsPer100: 0, fatPer100: 13, fiberPer100: null };

function stew(): Meal {
  const items = [
    {
      id: "00000000-0000-0000-0000-0000000000a1",
      foodItemId: "00000000-0000-0000-0000-0000000000f1",
      name: "Köttfärs",
      brand: null,
      amount: 800,
      unit: "g",
      grams: 800,
      position: 0,
      food: { ...MINCE, isEstimate: false },
    },
    {
      id: "00000000-0000-0000-0000-0000000000a2",
      foodItemId: null,
      name: "Mormors sås",
      brand: null,
      amount: 2,
      unit: "dl",
      grams: 200,
      position: 1,
      food: null,
    },
  ];
  return {
    id: "00000000-0000-0000-0000-0000000000m1",
    clientUuid: "00000000-0000-0000-0000-0000000000c1",
    name: "Köttfärssås",
    portions: 4,
    defaultMealSlot: null,
    recentLogs: 0,
    loggedCount: 0,
    lastLoggedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    items,
    perPortion: mealNutrition(
      items.map((item) => ({ grams: item.grams, food: item.food })),
      4,
    ),
    photoUrl: null,
    sharedAt: null,
    copiedFromName: null,
  };
}

describe("the Måltider section", () => {
  afterEach(cleanup);

  it("lists a meal with its portions and its figure per portion, minst where a row is gone", async () => {
    renderRoute(<Meals />, {
      responses: [
        { match: "/api/me", body: ME },
        { match: "/api/llm/health", body: { enabled: false, reachable: false, vision: false } },
      ],
      stateful: [{ match: "/api/meals", get: () => ({ meals: [stew()] }) }],
    });

    const list = await screen.findByTestId("meal-list");
    expect(list.textContent).toContain("Köttfärssås");
    expect(list.textContent).toContain("4 portioner");
    // 1 600 kcal over four, and a row whose food is gone makes it a floor.
    expect(list.textContent).toContain("minst 400 kcal per portion");
  });

  it("opens the sheet with the running figure, and saves the edit it was given", async () => {
    const patched: unknown[] = [];
    renderRoute(<Meals />, {
      responses: [
        { match: "/api/me", body: ME },
        { match: "/api/llm/health", body: { enabled: false, reachable: false, vision: false } },
      ],
      stateful: [
        {
          match: "/api/meals",
          get: () => ({ meals: [stew()] }),
          post: (body) => patched.push(body),
          wrote: stew(),
        },
      ],
    });

    fireEvent.click(await screen.findByTestId(`meal-open-${stew().id}`));
    const sheet = await screen.findByTestId("meal-sheet");
    expect(sheet.textContent).toContain("minst 400 kcal per portion");

    // Two portions instead of four: the running figure follows at once.
    fireEvent.change(screen.getByLabelText(sv["meals.portions"]), { target: { value: "2" } });
    await waitFor(() =>
      expect(screen.getByTestId("meal-sheet-figures").textContent).toContain(
        "minst 800 kcal per portion",
      ),
    );

    // The gone row is removed, and the figure is whole again.
    fireEvent.click(screen.getByTestId("meal-row-remove-Mormors sås"));
    await waitFor(() =>
      expect(screen.getByTestId("meal-sheet-figures").textContent).toContain(
        "800 kcal per portion",
      ),
    );
    expect(screen.getByTestId("meal-sheet-figures").textContent).not.toContain("minst");

    fireEvent.click(screen.getByTestId("meal-save"));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toMatchObject({
      name: "Köttfärssås",
      portions: 2,
      items: [{ nameSnapshot: "Köttfärs", amount: 800, unit: "g", grams: 800 }],
    });
  });

  it("refuses to save a meal with no name, and says so", async () => {
    renderRoute(<Meals />, {
      responses: [
        { match: "/api/me", body: ME },
        { match: "/api/llm/health", body: { enabled: false, reachable: false, vision: false } },
      ],
      stateful: [{ match: "/api/meals", get: () => ({ meals: [] }) }],
    });
    fireEvent.click(await screen.findByTestId("meal-new"));
    fireEvent.click(await screen.findByTestId("meal-save"));
    expect((await screen.findByRole("alert")).textContent).toBe(sv["meals.needName"]);
  });
});

describe("spara som måltid, beside logga", () => {
  afterEach(cleanup);

  const items: FoodMatch[] = [
    {
      name: "havregryn",
      estimatedGrams: 40,
      portion: null,
      portionSource: "hint",
      confidence: 0.9,
      match: {
        foodItemId: "00000000-0000-0000-0000-0000000000f2",
        name: "Havregryn",
        brand: null,
        kcalPer100: 370,
        kcal: 148,
        servingHints: null,
      },
    },
    {
      name: "mormors sylt",
      estimatedGrams: 20,
      portion: null,
      portionSource: "estimate",
      confidence: 0.5,
      match: null,
    },
  ] as FoodMatch[];

  it("saves only the rows the database matched, under the name typed", async () => {
    const saved: { rows: unknown[]; name: string }[] = [];
    renderRoute(
      <ParsedProposal
        items={items}
        intro=""
        saving={false}
        onConfirm={async () => {}}
        onCancel={() => {}}
        onSaveAsMeal={async (rows, name) => {
          saved.push({ rows, name });
        }}
        mealName="havregryn med sylt"
      />,
      { responses: [] },
    );

    fireEvent.click(screen.getByTestId("save-as-meal"));
    fireEvent.click(screen.getByTestId("save-as-meal-confirm"));
    await waitFor(() => expect(saved).toHaveLength(1));

    expect(saved[0]!.name).toBe("havregryn med sylt");
    expect(saved[0]!.rows).toEqual([
      expect.objectContaining({ foodItemId: "00000000-0000-0000-0000-0000000000f2", grams: 40 }),
    ]);
    expect(screen.getByRole("status").textContent).toContain("1 rader utan träff");
  });

  it("is absent in collect mode, where the rows join a meal already being made", () => {
    renderRoute(
      <ParsedProposal
        items={items}
        intro=""
        saving={false}
        requireMatch
        confirmLabel={(count) => `Lägg till ${count} rader`}
        onConfirm={async () => {}}
        onCancel={() => {}}
      />,
      { responses: [] },
    );
    expect(screen.queryByTestId("save-as-meal")).toBeNull();
    expect(screen.getByText(sv["meals.cannotTake"])).toBeTruthy();
  });
});
