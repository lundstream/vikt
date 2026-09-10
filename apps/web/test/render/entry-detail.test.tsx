/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { FoodLog } from "../../src/routes/FoodLog.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * A logged row opens onto what is actually in it (D125).
 *
 * The collapsed line carries a name, an amount and a calorie figure, and every
 * other fact about the entry — its macros, where the numbers came from, whether
 * somebody estimated them — was only ever in the database. A reader comparing a
 * day against a macro target had no way to see which entry was carrying the
 * fibre, or that one of them was a guess.
 *
 * The actions moved in with it. Three controls per row, on four rows, is twelve
 * targets a thumb has to aim between on a 360 px screen; inside a disclosure
 * they belong to the one row somebody has chosen to look at.
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

const INSIGHTS = {
  asOf: "2026-09-10",
  maintenance: {
    tdee: null,
    source: "none",
    windowDays: 0,
    coverage: 0,
    confidence: 0,
    missing: [],
    daysUntilAdaptive: null,
    blockedBy: null,
  },
  trendWeightKg: null,
  todayIntakeKcal: null,
  targetIntakeKcal: null,
  goalWeightKg: null,
  projections: { onPlan: null, atCurrentPace: null },
  readingCount: 0,
  planReview: null,
  systemFloorKcal: 1200,
  exerciseAdjustment: {
    available: false,
    inForce: false,
    preference: false,
    reason: "no_maintenance_figure",
  },
  whtr: [],
  whtrRuleOfThumb: 0.5,
  bmi: null,
  macros: null,
  todayRemainingKcal: null,
};

/** Looked up in a database, every macro present. */
const LOOKED_UP = {
  id: "11111111-1111-1111-1111-111111111111",
  clientUuid: "aaaaaaaa-1111-1111-1111-111111111111",
  localDate: "2026-09-10",
  loggedAt: "2026-09-10T08:00:00.000Z",
  mealSlot: "breakfast",
  foodItemId: "22222222-2222-2222-2222-222222222222",
  name: "Havregryn",
  brand: "Kungsörnen",
  grams: 80,
  kcal: 300,
  proteinG: 10,
  carbsG: 55,
  fatG: 6,
  fiberG: 8,
  confidence: 1,
  confirmed: true,
};

/** Typed in and guessed at: no food item, no fibre, confidence below 1. */
const ESTIMATED = {
  ...LOOKED_UP,
  id: "33333333-3333-3333-3333-333333333333",
  clientUuid: "aaaaaaaa-3333-3333-3333-333333333333",
  name: "Gryta hos mormor",
  brand: null,
  foodItemId: null,
  fiberG: null,
  confidence: 0.5,
};

function mount() {
  renderRoute(<FoodLog />, {
    responses: [
      { match: "/api/me", body: ME },
      { match: "/api/insights", body: INSIGHTS },
    ],
    stateful: [
      { match: "/api/food-entry/recent", get: () => ({ entries: [] }) },
      { match: "/api/food-entry", get: () => ({ entries: [LOOKED_UP, ESTIMATED] }) },
    ],
  });
}

describe("a logged row", () => {
  afterEach(cleanup);

  it("is closed until it is tapped", async () => {
    mount();
    await screen.findByTestId(`expand-entry-${LOOKED_UP.id}`);

    expect(screen.queryByTestId(`entry-detail-${LOOKED_UP.id}`)).toBeNull();
    // And the actions are not sitting on the collapsed line either.
    expect(screen.queryByTestId(`edit-entry-${LOOKED_UP.id}`)).toBeNull();
    expect(screen.queryByTestId(`delete-entry-${LOOKED_UP.id}`)).toBeNull();
  });

  it("shows the macros, the amount and the source when opened", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`expand-entry-${LOOKED_UP.id}`));

    const detail = await screen.findByTestId(`entry-detail-${LOOKED_UP.id}`);
    const text = detail.textContent ?? "";

    for (const grams of ["10 g", "55 g", "6 g", "8 g"]) {
      expect(text, `missing ${grams}`).toContain(grams);
    }
    expect(text).toContain("80 g");
    expect(text).toContain(sv["food.sourceDatabase"]);
    expect(text).toContain("Kungsörnen");
  });

  /** Edit and delete ship with the row that displays it (D56). */
  it("carries edit and delete inside the disclosure", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`expand-entry-${LOOKED_UP.id}`));

    expect(await screen.findByTestId(`edit-entry-${LOOKED_UP.id}`)).toBeTruthy();
    expect(screen.getByTestId(`delete-entry-${LOOKED_UP.id}`)).toBeTruthy();

    // And editing opens in place rather than anywhere else.
    fireEvent.click(screen.getByTestId(`edit-entry-${LOOKED_UP.id}`));
    expect(await screen.findByTestId(`save-entry-${LOOKED_UP.id}`)).toBeTruthy();
  });

  /**
   * Absent is not zero (D44). A fibre figure nobody recorded is not a fibre
   * figure of zero, and an estimate says so rather than reading as a lookup.
   */
  it("says 'inte än' for a macro the entry does not carry, and marks an estimate", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`expand-entry-${ESTIMATED.id}`));

    const detail = await screen.findByTestId(`entry-detail-${ESTIMATED.id}`);
    expect(detail.textContent).toContain(sv["stat.notYet"]);
    expect(detail.textContent).toContain(sv["food.sourceTyped"]);

    // The estimate marker sits on the collapsed line, so it is visible without
    // opening anything: it changes how the number should be read.
    const row = screen.getByTestId(`expand-entry-${ESTIMATED.id}`);
    expect(row.textContent).toContain(sv["estimate.badge"]);
  });

  /** One at a time: opening the second closes the first. */
  it("keeps one row open at a time", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`expand-entry-${LOOKED_UP.id}`));
    await screen.findByTestId(`entry-detail-${LOOKED_UP.id}`);

    fireEvent.click(screen.getByTestId(`expand-entry-${ESTIMATED.id}`));
    await screen.findByTestId(`entry-detail-${ESTIMATED.id}`);

    expect(screen.queryByTestId(`entry-detail-${LOOKED_UP.id}`)).toBeNull();
  });

  /** And tapping the open one closes it. */
  it("closes on a second tap", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`expand-entry-${LOOKED_UP.id}`));
    await screen.findByTestId(`entry-detail-${LOOKED_UP.id}`);

    fireEvent.click(screen.getByTestId(`expand-entry-${LOOKED_UP.id}`));
    expect(screen.queryByTestId(`entry-detail-${LOOKED_UP.id}`)).toBeNull();
  });
});
