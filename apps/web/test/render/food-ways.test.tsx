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
 * The row has to read with **two, three, four or five** items, because the
 * model-backed ones are absent rather than disabled when the box is off, and
 * the photograph has a further condition of its own: some tag has to have been
 * proved able to see, and this device has to be online (D143).
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

function mount(llmReachable: boolean, vision = true) {
  renderRoute(<FoodLog />, {
    responses: [
      { match: "/api/me", body: ME },
      { match: "/api/insights", body: INSIGHTS },
      {
        match: "/api/llm/health",
        body: { enabled: llmReachable, reachable: llmReachable, vision },
      },
    ],
    stateful: [
      { match: "/api/food-entry/recent", get: () => ({ entries: [] }) },
      { match: "/api/food-entry", get: () => ({ entries: [] }) },
    ],
  });
}

describe("the ways into the food screen", () => {
  afterEach(cleanup);

  /** All five, when a model is answering and one of them can see. */
  it("offers five when the model is reachable and can see", async () => {
    mount(true);
    await screen.findByTestId("scan");

    for (const id of [
      "scan",
      "open-photo-entry",
      "open-estimate",
      "open-text-entry",
      "open-recipe",
    ]) {
      expect(screen.getByTestId(id), `missing ${id}`).toBeTruthy();
    }
  });

  /**
   * The photograph has a condition of its own (D143). A reachable workstation
   * is not enough: some tag has to have been sent a picture and described it,
   * which is what `vision` reports. Absent rather than greyed, like everything
   * else in this phase.
   */
  it("leaves the photograph out when nothing has proved it can see", async () => {
    mount(true, false);
    await screen.findByTestId("scan");

    expect(screen.queryByTestId("open-photo-entry")).toBeNull();
    // The other three model-backed doors are unaffected.
    expect(screen.getByTestId("open-text-entry")).toBeTruthy();
    expect(screen.getByTestId("open-recipe")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toContain(sv["photo.take"]);
  });

  /**
   * And offline it is absent too, which is not true of the others.
   *
   * They degrade to an unavailable answer; this one cannot be attempted at all,
   * because the image is never queued. A door that opened onto "try again when
   * you have signal" would be asking somebody to photograph their dinner twice.
   */
  it("leaves the photograph out when the device is offline", async () => {
    const online = Object.getOwnPropertyDescriptor(
      window.navigator.constructor.prototype,
      "onLine",
    );
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    try {
      mount(true);
      await screen.findByTestId("scan");
      expect(screen.queryByTestId("open-photo-entry")).toBeNull();
      expect(screen.getByTestId("open-text-entry")).toBeTruthy();
    } finally {
      if (online) Object.defineProperty(window.navigator, "onLine", online);
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
    expect(screen.queryByTestId("open-photo-entry")).toBeNull();

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
    expect(row!.querySelectorAll("li")).toHaveLength(5);

    // Every one carries its label as text.
    for (const [id, label] of [
      ["scan", sv["action.scan"]],
      ["open-photo-entry", sv["photo.take"]],
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

    for (const id of [
      "scan",
      "open-photo-entry",
      "open-estimate",
      "open-text-entry",
      "open-recipe",
    ]) {
      const element = screen.getByTestId(id);
      for (const tier of ["btn", "btn-small", "btn-link", "btn-impact"]) {
        expect(element.classList.contains(tier), `${id} is a ${tier}`).toBe(false);
      }
    }

    void scan;
  });
});
