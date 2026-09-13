/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { addDays } from "shared";
import { shiftMonth } from "../../src/components/MonthCalendar.js";
import { todayLocalDate } from "../../src/lib/dates.js";
import { renderRoute } from "./harness.js";
import { Dashboard } from "../../src/routes/Dashboard.js";
import { db } from "../../src/lib/queue/db.js";

/**
 * Every reading is reachable, not the last five (D145).
 *
 * §3 says every user-created row ships with edit and delete. The weight log had
 * both in the API from phase 1 and, on screen, a list of the five most recent
 * readings with a delete beside each. A weight mistyped in July showed on the
 * chart as a spike for three months and there was no way to touch it: the
 * correct fix was to delete the row and type it again, and the control to do
 * that was five rows out of reach.
 *
 * What is held here is that the calendar reaches a reading the list does not
 * show, that tapping it opens the same sheet the list opens, and that tapping
 * an **empty** day is an add rather than nothing.
 */

const TZ = "Europe/Stockholm";
const today = todayLocalDate(TZ);

const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "test@example.test",
  displayName: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  profile: {
    heightCm: 180,
    birthDate: null,
    sex: "unspecified",
    timezone: TZ,
    locale: "sv-SE",
    activityFactor: 1.35,
    addExerciseToTarget: false,
    soberAssumeUnloggedDry: false,
    lastDrinkOn: null,
    macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
  },
};

const INSIGHTS = {
  asOf: today,
  maintenance: {
    tdee: null, source: "none", windowDays: 0, coverage: 0, confidence: 0,
    missing: [], daysUntilAdaptive: null, blockedBy: null,
  },
  trendWeightKg: null, todayIntakeKcal: null, targetIntakeKcal: null,
  goalWeightKg: null, projections: { onPlan: null, atCurrentPace: null },
  readingCount: 0, planReview: null, systemFloorKcal: 1200,
  exerciseAdjustment: {
    available: false, inForce: false, preference: false, reason: "no_maintenance_figure",
  },
  whtr: [], whtrRuleOfThumb: 0.5, bmi: null, macros: null, todayRemainingKcal: null,
};

/**
 * Eight readings, five of which are off the end of the list. The oldest sits in
 * **last month**, which is the only month guaranteed to be entirely in the past
 * however the calendar happens to be run: a fixture placed in the current month
 * lands in the future on the first of it, once a month, and fails on a clock
 * rather than on the code.
 */
const LAST_MONTH = shiftMonth(today.slice(0, 7), -1);
const OLDEST = `${LAST_MONTH}-10`;
/** A day in the same month with nothing on it. */
const EMPTY = `${LAST_MONTH}-11`;
const READINGS = [
  { id: "r-0", localDate: OLDEST, weightKg: 94.4, source: "manual" },
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `r-${index + 1}`,
    localDate: addDays(today, -(7 - index)),
    weightKg: 92 + index * 0.1,
    source: "manual" as const,
  })),
];

function mount(posted: unknown[] = []) {
  renderRoute(<Dashboard />, {
    responses: [
      { match: "/api/me", body: ME },
      { match: "/api/insights", body: INSIGHTS },
      { match: "/api/llm/health", body: { enabled: false, reachable: false, vision: false } },
    ],
    stateful: [
      {
        match: "/api/weight",
        get: () => ({ entries: READINGS }),
        post: (body) => posted.push(body),
      },
      { match: "/api/manual-intake", get: () => ({ entries: [] }) },
    ],
  });
}

afterEach(async () => {
  cleanup();
  await db.mutations.clear();
});

/** Opens the readings disclosure and then the calendar under it. */
async function openCalendar() {
  fireEvent.click(await screen.findByTestId("recent-readings"));
  fireEvent.click(await screen.findByTestId("open-calendar"));
  return screen.findByTestId("weight-calendar");
}

/** The same, stepped back to the month the old reading is in. */
async function openLastMonth() {
  const calendar = await openCalendar();
  fireEvent.click(screen.getByTestId("calendar-previous"));
  return calendar;
}

describe("the readings list", () => {
  /**
   * The list is still the last five, deliberately: the chart is the hero and a
   * ledger under it would compete with the line. What changed is that the five
   * are no longer the only ones that exist.
   */
  it("shows five of eight and offers the rest behind a link", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("recent-readings"));

    await waitFor(() => {
      expect(screen.getByTestId("edit-weight-r-7")).toBeTruthy();
    });
    expect(screen.queryByTestId("edit-weight-r-0")).toBeNull();
    expect(screen.getByTestId("open-calendar")).toBeTruthy();
  });

  /** A row is the edit now, not a line of text with a delete beside it. */
  it("opens the sheet on that day when a row is tapped", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("recent-readings"));
    fireEvent.click(await screen.findByTestId("edit-weight-r-7"));

    const date = (await screen.findByLabelText("Dag")) as HTMLInputElement;
    expect(date.value).toBe(addDays(today, -1));
    // The day's own reading, not the most recent one.
    const weight = screen.getByLabelText("Vikt (kg)") as HTMLInputElement;
    expect(weight.value).toBe("92,6");
    // And the row's delete, on the screen that shows the row (§3).
    expect(screen.getByTestId("delete-weight-entry")).toBeTruthy();
  });
});

describe("the month calendar", () => {
  it("marks the days that have a reading and leaves the rest bare", async () => {
    mount();
    await openLastMonth();

    expect(screen.getByTestId(`day-${OLDEST}`).dataset.marked).toBe("true");
    expect(screen.getByTestId(`day-${EMPTY}`).dataset.marked).toBeUndefined();
  });

  /**
   * The one the five-row list could not do. This reading is older than the
   * five on screen and the calendar is the only way to it.
   */
  it("reaches a reading the list does not show", async () => {
    mount();
    await openLastMonth();

    fireEvent.click(screen.getByTestId(`day-${OLDEST}`));

    const date = (await screen.findByLabelText("Dag")) as HTMLInputElement;
    expect(date.value).toBe(OLDEST);
    expect((screen.getByLabelText("Vikt (kg)") as HTMLInputElement).value).toBe("94,4");
    expect(screen.getByTestId("delete-weight-entry")).toBeTruthy();
  });

  /**
   * An empty day is an add, not a dead cell. The date travels into the write,
   * and `enqueue` stamps it `chosen` because it is not the device's own day
   * (D61) — which is what tells a backfill from a wrong clock later.
   */
  it("adds a reading on an empty day, filed under that day", async () => {
    const posted: unknown[] = [];
    mount(posted);
    await openLastMonth();

    fireEvent.click(screen.getByTestId(`day-${EMPTY}`));

    const date = (await screen.findByLabelText("Dag")) as HTMLInputElement;
    expect(date.value).toBe(EMPTY);
    // Nothing to remove on a day with no reading.
    expect(screen.queryByTestId("delete-weight-entry")).toBeNull();

    fireEvent.change(screen.getByLabelText("Vikt (kg)"), { target: { value: "93,2" } });
    fireEvent.click(screen.getByText("Spara"));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      localDate: EMPTY,
      weightKg: 93.2,
      dateSource: "chosen",
    });
  });

  /** Today is not a future day and the month after this one is not a place. */
  it("offers no way into a month that has not happened", async () => {
    mount();
    await openCalendar();

    expect(screen.queryByTestId("calendar-next")).toBeNull();
    expect(screen.getByTestId("calendar-previous")).toBeTruthy();
  });

  /**
   * Keyboard reachable on desktop, which is what a real button buys and a div
   * with a click handler does not (§5's quality floor).
   */
  it("puts every day in the tab order as a button", async () => {
    mount();
    const calendar = await openCalendar();

    const cells = calendar.querySelectorAll('[role="gridcell"]');
    expect(cells.length).toBeGreaterThan(27);
    for (const cell of cells) expect(cell.tagName).toBe("BUTTON");
  });
});
