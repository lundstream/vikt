/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderRoute } from "./harness.js";

import { Dashboard } from "../../src/routes/Dashboard.js";
import { DailyLog } from "../../src/routes/DailyLog.js";
import { FoodLog } from "../../src/routes/FoodLog.js";
import { Progress } from "../../src/routes/Progress.js";
import { Correlations } from "../../src/routes/Correlations.js";
import { Data } from "../../src/routes/Data.js";
import { Profile } from "../../src/routes/Profile.js";
import { Settings } from "../../src/routes/Settings.js";
import { Login } from "../../src/routes/Login.js";
import { Register } from "../../src/routes/Register.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * Every route mounts and renders its heading.
 *
 * That is the whole assertion, and it is deliberately that weak. These exist
 * because this project shipped a blank dashboard: a `const` read inside a
 * callback before its declaration typechecks cleanly — TypeScript cannot prove
 * when the callback runs — and threw at render. The full suite passed. A
 * screenshot caught it.
 *
 * So: not visual regression, not behaviour. Proof that a route is not blank,
 * for every route, cheaply enough that it runs on every commit.
 *
 * The profile query is stubbed as a signed-in user, because several routes read
 * the timezone off it and a null profile would exercise a different path from
 * the one people actually see.
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

/**
 * A valid, empty insights payload.
 *
 * The stub answers unmatched requests with `{}`, and `{}` is truthy, so the
 * dashboard rendered its insight panel against a payload with no `maintenance`
 * on it and threw. That is the harness feeding garbage rather than an app
 * defect — the real endpoint is schema-validated on both sides — but the fix is
 * to hand these tests a shape the app could actually receive, because a smoke
 * test that has to be defended against is not testing the render path.
 */
const INSIGHTS = {
  asOf: "2026-09-02",
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

const RESPONSES = [
  { match: "/api/me", body: ME },
  { match: "/api/insights", body: INSIGHTS },
];

afterEach(cleanup);

/**
 * Heading text rather than a test id, so the assertion is what a person would
 * see. Taken from the dictionary rather than typed twice, so renaming a screen
 * does not silently stop testing it.
 */
const ROUTES = [
  // The signed-in screens. `appName()` falls back to "Vikt" without the meta
  // tag the real page carries, which is what the two wordmark headings match.
  { name: "dashboard", element: <Dashboard />, heading: "Vikt", signedIn: true },
  { name: "daily", element: <DailyLog />, heading: sv["daily.title"], signedIn: true },
  { name: "food", element: <FoodLog />, heading: sv["food.title"], signedIn: true },
  { name: "progress", element: <Progress />, heading: sv["progress.title"], signedIn: true },
  { name: "correlations", element: <Correlations />, heading: sv["corr.title"], signedIn: true },
  { name: "data", element: <Data />, heading: sv["data.title"], signedIn: true },
  { name: "profile", element: <Profile />, heading: sv["profile.title"], signedIn: true },
  { name: "settings", element: <Settings />, heading: sv["settings.title"], signedIn: true },

  // Signed out, because signed in these redirect, and a redirect renders
  // nothing. Asserting a blank page there would be asserting the wrong thing.
  { name: "login", element: <Login />, heading: "Vikt", signedIn: false },
  { name: "register", element: <Register />, heading: "Vikt", signedIn: false },
] as const;

describe("every route mounts", () => {
  for (const route of ROUTES) {
    it(`renders ${route.name} without blanking`, async () => {
      const { container } = renderRoute(route.element, {
        responses: RESPONSES,
        ...(route.signedIn ? {} : { unauthorized: ["/api/me"] }),
      });

      /**
       * Waited for rather than asserted immediately: a route whose identity
       * query has not settled legitimately renders nothing for a tick, and
       * "blank forever" is the failure, not "blank on the first frame".
       */
      expect(
        await screen.findByRole("heading", { name: route.heading, level: 1 }),
      ).toBeDefined();

      // Not blank. The failure this whole file exists for.
      expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    });
  }
});

/**
 * The two screens that gained client-side state in this pass, checked a little
 * harder: state is exactly what a smoke test would otherwise walk straight
 * past, because a broken reducer still renders a heading.
 */
describe("the date selector", () => {
  it("is on both logging screens", async () => {
    for (const element of [<DailyLog key="d" />, <FoodLog key="f" />]) {
      renderRoute(element, { responses: RESPONSES });
      expect(await screen.findByTestId("date-picker")).toBeDefined();
      cleanup();
    }
  });

  it("opens on today, with no way forward from it", async () => {
    renderRoute(<DailyLog />, { responses: RESPONSES });

    const forward = await screen.findByTestId("date-forward");
    expect((forward as HTMLButtonElement).disabled).toBe(true);
    // The "back to today" escape hatch only exists when there is somewhere to
    // come back from.
    expect(screen.queryByTestId("date-today")).toBeNull();
  });
});

describe("the data viewer", () => {
  /**
   * jsdom reports a narrow viewport, so this exercises the portrait view: one
   * series at a time behind a picker rather than ten stacked panels (D67). The
   * picker still has to name every series, which is what stops one going
   * missing from the reduced view.
   */
  it("offers every series in the picker", async () => {
    renderRoute(<Data />, { responses: RESPONSES });

    const picker = (await screen.findByTestId("series-picker")) as HTMLSelectElement;
    expect(picker.options).toHaveLength(10);

    const labels = [...picker.options].map((option) => option.textContent);
    for (const label of [
      sv["daily.energy"],
      sv["daily.mood"],
      sv["daily.sweat"],
      sv["daily.hunger"],
      sv["data.sleep"],
      sv["data.steps"],
      sv["data.alcohol"],
      sv["data.activity"],
      sv["data.waist"],
      sv["data.intake"],
    ]) {
      expect(labels).toContain(label);
    }
  });

  it("renders the chosen one", async () => {
    renderRoute(<Data />, { responses: RESPONSES });
    expect(await screen.findByRole("region", { name: sv["daily.energy"] })).toBeDefined();
  });

  /** D34: a viewer, not an analysis. Nothing here may read as a finding. */
  it("says what it is, at the foot", async () => {
    renderRoute(<Data />, { responses: RESPONSES });
    expect(await screen.findByText(sv["data.footer"])).toBeDefined();
  });
});

