/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { FoodLog } from "../../src/routes/FoodLog.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * The ways into the food screen are one row of quick actions (D135).
 *
 * Scanning, typing an estimate, describing a meal and asking for a recipe all
 * open another surface. Three of them were full-width outlined buttons stacked
 * down the page, which said "press me" three times for things that only open a
 * sheet; the fourth was already a circle. They are one shape now.
 *
 * The row has to read with **two, three or four** items, because the two
 * model-backed ones are absent rather than disabled when the box is off.
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
  asOf: "2026-09-11",
  maintenance: {
    tdee: null, source: "none", windowDays: 0, coverage: 0, confidence: 0,
    missing: [], daysUntilAdaptive: null, blockedBy: null,
  },
  trendWeightKg: null, todayIntakeKcal: null, targetIntakeKcal: null,
  goalWeightKg: null, projections: { onPlan: null, atCurrentPace: null },
  readingCount: 0, planReview: null, systemFloorKcal: 1200,
  exerciseAdjustment: { available: false, inForce: false, preference: false, reason: "no_maintenance_figure" },
  whtr: [], whtrRuleOfThumb: 0.5, bmi: null, macros: null, todayRemainingKcal: null,
};

function mount(llmReachable: boolean) {
  renderRoute(<FoodLog />, {
    responses: [
      { match: "/api/me", body: ME },
      { match: "/api/insights", body: INSIGHTS },
      { match: "/api/llm/health", body: { enabled: llmReachable, reachable: llmReachable } },
    ],
    stateful: [
      { match: "/api/food-entry/recent", get: () => ({ entries: [] }) },
      { match: "/api/food-entry", get: () => ({ entries: [] }) },
    ],
  });
}

describe("the ways into the food screen", () => {
  afterEach(cleanup);

  /** All four, when a model is answering. */
  it("offers four when the model is reachable", async () => {
    mount(true);
    await screen.findByTestId("scan");

    for (const id of ["scan", "open-estimate", "open-text-entry", "open-recipe"]) {
      expect(screen.getByTestId(id), `missing ${id}`).toBeTruthy();
    }
  });

  /**
   * Two when it is not. Absent, not disabled: §6's rule for the whole phase 8
   * surface is that an unavailable feature leaves no trace.
   */
  it("offers two when the model is not reachable, with no trace of the others", async () => {
    mount(false);
    await screen.findByTestId("scan");

    expect(screen.getByTestId("open-estimate")).toBeTruthy();
    expect(screen.queryByTestId("open-text-entry")).toBeNull();
    expect(screen.queryByTestId("open-recipe")).toBeNull();

    // And nothing says the missing ones exist.
    const body = document.body.textContent ?? "";
    expect(body).not.toContain(sv["llm.title"]);
    expect(body).not.toContain(sv["recipe.title"]);
  });

  /**
   * They are quick actions, not buttons: a labelled circle, the shape the
   * profile gives an entry point (page 6). The label is visible rather than
   * only an accessible name, because these are used by somebody not paying
   * full attention.
   */
  it("renders them as labelled quick actions in one row", async () => {
    mount(true);
    const scan = await screen.findByTestId("scan");

    const row = scan.closest("ul");
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll("li")).toHaveLength(4);

    // Every one carries its label as text.
    for (const [id, label] of [
      ["scan", sv["action.scan"]],
      ["open-estimate", sv["estimate.open"]],
      ["open-text-entry", sv["llm.title"]],
      ["open-recipe", sv["recipe.title"]],
    ] as const) {
      expect(screen.getByTestId(id).textContent, `${id} has no label`).toContain(label);
    }

    // And each has an icon rather than being text alone.
    expect(scan.querySelector("svg")).not.toBeNull();
  });

  /** None of them is a button in the three-tier sense (D134, D135). */
  it("uses no button tier for an entry point", async () => {
    mount(true);
    const scan = await screen.findByTestId("scan");

    for (const id of ["scan", "open-estimate", "open-text-entry", "open-recipe"]) {
      const element = screen.getByTestId(id);
      for (const tier of ["btn", "btn-small", "btn-link", "btn-impact"]) {
        expect(element.classList.contains(tier), `${id} is a ${tier}`).toBe(false);
      }
    }

    void scan;
  });
});
