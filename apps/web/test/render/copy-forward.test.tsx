/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { FoodLog } from "../../src/routes/FoodLog.js";

/**
 * Two actions that both log a food again, onto two different days (D124).
 *
 *  - **"Igen"**, under Senast loggat, writes to the day being *viewed*. That is
 *    backfilling: somebody filling in last Tuesday wants last Tuesday.
 *  - **"Logga i dag"**, on a past day's rows, writes to *today*. That is
 *    somebody looking at yesterday and eating the same thing again.
 *
 * The pair is the whole feature, so the test is the pair. Asserting only that
 * the new action writes to today would pass just as happily on a build where
 * "Igen" had quietly started doing the same, which would silently break
 * backfilling — the older of the two behaviours and the one nobody would think
 * to re-check.
 *
 * `local_date` is read off the request body rather than from any UI text: it is
 * the field D61 is about, and the screen never shows it.
 */

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const ENTRY = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Havregryn",
  grams: 80,
  kcal: 300,
  mealSlot: "breakfast",
  foodItemId: "22222222-2222-2222-2222-222222222222",
  confidence: null,
  estimated: false,
  proteinG: 10,
  carbsG: 55,
  fatG: 6,
  fiberG: 8,
  source: "manual",
};

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

/**
 * Mounts the screen with the harness's own stub, and records every food-entry
 * write through a `stateful` route so the day each one names can be read back.
 *
 * The harness installs its fetch stub inside `renderRoute`, so assigning
 * `globalThis.fetch` beforehand is overwritten — the first version of this test
 * did exactly that and saw a screen that never loaded.
 */
function mount(posted: string[]) {
  renderRoute(<FoodLog />, {
    responses: [
      { match: "/api/me", body: ME },
      { match: "/api/insights", body: INSIGHTS },
      { match: "/api/meal-templates", body: { templates: [] } },
      { match: "/api/food/favourites", body: { items: [] } },
    ],
    stateful: [
      {
        match: "/api/food-entry/recent",
        get: () => ({ entries: [ENTRY] }),
      },
      {
        match: "/api/food-entry",
        get: () => ({ entries: [ENTRY] }),
        post: (body) => {
          posted.push(String((body as { localDate?: unknown }).localDate));
        },
      },
    ],
  });
}

/**
 * Steps the screen back one day the way a person does. The date lives in
 * context rather than the URL (D62), so there is nothing to seed — and driving
 * the control means the test exercises the selector too.
 */
async function goToYesterday(): Promise<void> {
  // The native date input *is* the picker (see DateSelector): the readable
  // Swedish day is drawn under a transparent, full-size `input[type=date]`.
  // Changing it is what a person does with the calendar, and it is the control
  // the smoke tests already prove renders.
  const picker = await screen.findByTestId("date-picker");
  fireEvent.change(picker, { target: { value: YESTERDAY } });
}

describe("logging a past day's food again", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The new action. Viewing yesterday, the row offers "Logga i dag" and it
   * writes to today.
   */
  it("copies one row onto today, from a past day", async () => {
    const posted: string[] = [];
    mount(posted);

    await goToYesterday();

    fireEvent.click(await screen.findByTestId(`copy-entry-${ENTRY.id}`));

    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted).toEqual([TODAY]);

  });

  /** And the whole day, for somebody who ate the same as yesterday. */
  it("copies the whole day onto today", async () => {
    const posted: string[] = [];
    mount(posted);

    await goToYesterday();

    fireEvent.click(await screen.findByTestId("copy-day-to-today"));

    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    for (const day of posted) expect(day).toBe(TODAY);

  });

  /**
   * The direction that already worked, and the one a change here would break
   * without anybody noticing. "Igen" still backfills.
   */
  it("still logs Igen to the day being viewed, not to today", async () => {
    const posted: string[] = [];
    mount(posted);

    await goToYesterday();

    fireEvent.click(await screen.findByTestId("recent-foods"));

    await waitFor(() => expect(screen.getAllByTestId("log-again").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId("log-again")[0]!);

    await waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted, "Igen must still backfill").toEqual([YESTERDAY]);

  });

  /**
   * Viewing today, copying to today is an action with no effect, so it is
   * absent rather than disabled.
   */
  it("offers no copy action while viewing today", async () => {
    const posted: string[] = [];
    mount(posted);

    await screen.findByTestId(`edit-entry-${ENTRY.id}`);
    expect(screen.queryByTestId(`copy-entry-${ENTRY.id}`)).toBeNull();
    expect(screen.queryByTestId("copy-day-to-today")).toBeNull();

  });
});
