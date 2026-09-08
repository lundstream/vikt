/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Dashboard } from "../../src/routes/Dashboard.js";

/**
 * A fresh account with no height renders, and asks for what it needs (D105).
 *
 * Height left the registration form, so `profiles.height_cm` is null for every
 * account created from now on. Three things read it: BMI, waist-to-height, and
 * the Mifflin-St Jeor fallback. All three already handled its absence, because
 * D20 made "missing" a first-class answer rather than a zero — but "already
 * handled" is a claim about code nobody had run in that state, which is the
 * kind of claim this project has learned to distrust.
 *
 * So: the dashboard, with a profile that has no height and no readings at all.
 */

const NO_HEIGHT_ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "new@example.test",
  displayName: "Ny",
  createdAt: "2026-09-06T00:00:00.000Z",
  isAdmin: false,
  profile: {
    heightCm: null,
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

/**
 * What `/api/insights` returns for an account with nothing in it.
 *
 * The full shape rather than the fields this test reads, for the reason
 * `routes.test.tsx` gives: the stub answers an unmatched request with `{}`, and
 * a payload missing `maintenance` makes the insight panel throw. A smoke test
 * that has to be defended against is not testing the render path.
 *
 * `missing` names height among the fields the formula wants, which is D20's
 * design working: absent is named, never guessed.
 */
const EMPTY_INSIGHTS = {
  asOf: "2026-09-06",
  maintenance: {
    tdee: null,
    source: "none",
    windowDays: 0,
    coverage: 0,
    confidence: 0,
    missing: ["sex", "birthDate", "heightCm", "weightKg"],
    daysUntilAdaptive: 14,
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

const RESPONSES = [
  { match: "/api/me", body: NO_HEIGHT_ME },
  { match: "/api/insights", body: EMPTY_INSIGHTS },
];

describe("a brand new account, with no height", () => {
  afterEach(cleanup);

  it("renders the dashboard rather than failing", async () => {
    renderRoute(<Dashboard />, { path: "/", responses: RESPONSES });
    // The heading is enough: a throw during render leaves an empty container.
    expect(await screen.findByRole("heading", { name: "Vikt", level: 1 })).toBeTruthy();
  });

  /**
   * The three figures height feeds, each saying it does not know rather than
   * showing a zero, a dash or a number computed from a guessed height.
   */
  it("says what it does not know instead of inventing it", async () => {
    renderRoute(<Dashboard />, { path: "/", responses: RESPONSES });
    await screen.findByRole("heading", { name: "Vikt", level: 1 });

    // "Inte än" appears for the trend, today's weight, BMI and height.
    expect(screen.getAllByText("Inte än").length).toBeGreaterThanOrEqual(3);
    // And nothing anywhere claims a height it does not have.
    expect(screen.queryByText(/\d+ cm/)).toBeNull();
  });

  /**
   * The card is the whole of onboarding, so on an account with nothing it has
   * to offer all three steps and it has to be dismissible.
   */
  it("offers the three things that make the numbers real", async () => {
    renderRoute(<Dashboard />, { path: "/", responses: RESPONSES });

    expect(await screen.findByTestId("welcome-card")).toBeTruthy();
    expect(screen.getByTestId("welcome-weigh")).toBeTruthy();
    expect(screen.getByTestId("welcome-height")).toBeTruthy();
    expect(screen.getByTestId("welcome-goal")).toBeTruthy();
    expect(screen.getByTestId("welcome-dismiss")).toBeTruthy();
  });

  /** Height is one step of three, not a gate: the app is usable without it. */
  it("still shows the ways in to logging", async () => {
    renderRoute(<Dashboard />, { path: "/", responses: RESPONSES });
    await screen.findByRole("heading", { name: "Vikt", level: 1 });

    expect(screen.getByText("Väg dig")).toBeTruthy();
    expect(screen.getByText("Logga mat")).toBeTruthy();
  });
});

describe("an account that has done everything", () => {
  afterEach(cleanup);

  it("has no welcome card at all", async () => {
    renderRoute(<Dashboard />, {
      path: "/",
      responses: [
        { match: "/api/me", body: { ...NO_HEIGHT_ME, profile: { ...NO_HEIGHT_ME.profile, heightCm: 180 } } },
        { match: "/api/insights", body: { ...EMPTY_INSIGHTS, goalWeightKg: 80 } },
        {
          match: "/api/weight",
          body: {
            entries: [
              {
                id: "00000000-0000-0000-0000-0000000000a1",
                clientUuid: "00000000-0000-0000-0000-0000000000a2",
                localDate: "2026-09-05",
                loggedAt: "2026-09-05T07:00:00.000Z",
                weightKg: 88,
                source: "manual",
                note: null,
              },
            ],
          },
        },
      ],
    });

    await screen.findByRole("heading", { name: "Vikt", level: 1 });
    expect(screen.queryByTestId("welcome-card")).toBeNull();
  });
});
