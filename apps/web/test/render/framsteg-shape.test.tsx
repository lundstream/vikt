/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Progress } from "../../src/routes/Progress.js";
import { sv } from "../../src/i18n/sv.js";

/**
 * Framsteg leads with the figures and folds the setup away (D126).
 *
 * The screen had two lists open on arrival and two empty create forms below
 * them, so a page about how far there is left to go opened on four blocks of
 * things to type in. Both lists are reference material: they change when
 * somebody changes them, and until then they cost a line each.
 *
 * The two "add" buttons stay outside their folds on purpose. Adding a
 * milestone is not something you do to the list, so it must not cost a fold
 * first.
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

const MILESTONE = {
  id: "11111111-1111-1111-1111-111111111111",
  label: "Under 90",
  metric: "weight_kg",
  targetValue: 90,
  rewardText: null,
  rewardCostSek: null,
  sortOrder: 0,
  achievedAt: null,
  achievedValue: null,
  rewardClaimedAt: null,
  status: { state: "open", remaining: 4.2 },
  progress: 0.4,
  projectedDate: "2026-11-01",
  projectedDays: 52,
  rewardAffordable: null,
  daysUntilAffordable: null,
};

const RULE = {
  id: "22222222-2222-2222-2222-222222222222",
  label: "Lunch hemma",
  amountSek: 95,
  cadence: "weekday",
  startDate: "2026-06-01",
  endDate: null,
  active: true,
  weeklyRateSek: 475,
  accruedSek: 6650,
  eligibleDays: 70,
  offsetDays: 0,
};

const PROGRESS = {
  asOf: "2026-09-10",
  streak: { days: 12, graceUsed: 0, startedOn: "2026-08-29" },
  sober: {
    days: 30,
    lastDrinkOn: "2026-08-11",
    basis: "since_drink",
    countingFrom: "2026-08-11",
    rule: "strict",
  },
  pot: {
    asOf: "2026-09-10",
    accruedSek: 6650,
    eventsSek: 0,
    paidOutSek: 0,
    balanceSek: 6650,
    weeklyRateSek: 475,
    rules: [RULE],
    events: [],
    series: [
      { localDate: "2026-09-09", balanceSek: 6555 },
      { localDate: "2026-09-10", balanceSek: 6650 },
    ],
  },
  milestones: [MILESTONE],
  celebrate: null,
};

function mount() {
  renderRoute(<Progress />, {
    responses: [
      { match: "/api/me", body: ME },
      { match: "/api/progress", body: PROGRESS },
    ],
  });
}

describe("Framsteg", () => {
  afterEach(cleanup);

  /**
   * The header card is what somebody came for, and D60 put the distance to
   * every unreached milestone inside it. It must not arrive folded.
   */
  it("leads with the steady header and the pot, both open", async () => {
    mount();
    await screen.findByTestId("achieved-count");

    expect(screen.getByTestId("upcoming")).toBeTruthy();
    expect(screen.getByTestId("pot-balance")).toBeTruthy();
  });

  it("folds both lists away, each saying how many it holds", async () => {
    mount();
    const milestones = await screen.findByTestId("milestones");
    const rules = screen.getByTestId("savings-rules");

    expect(milestones.getAttribute("aria-expanded")).toBe("false");
    expect(rules.getAttribute("aria-expanded")).toBe("false");

    // The count is what makes a fold safe to leave folded.
    expect(milestones.textContent).toContain("1");
    expect(rules.textContent).toContain("1");
  });

  /** Folded, not unmounted: the rows are there for a screen reader to reach. */
  it("opens a fold onto its rows", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("milestones"));

    expect(screen.getByTestId(`edit-milestone-${MILESTONE.id}`)).toBeTruthy();
    // Twice on the page now: once as a distance in the header card, once as a
    // row in the fold. They are two different answers about the same milestone.
    expect(screen.getAllByText("Under 90")).toHaveLength(2);
  });

  /**
   * Adding is a button and a sheet, not a form sitting open under the list.
   * The button is reachable without opening the fold first.
   */
  it("puts the create forms behind buttons, outside the folds", async () => {
    mount();
    const open = await screen.findByTestId("open-milestone-form");

    // Nothing to fill in until it is asked for.
    expect(screen.queryByTestId("milestone-sheet")).toBeNull();
    expect(screen.queryByTestId("add-milestone")).toBeNull();

    fireEvent.click(open);
    const sheet = await screen.findByTestId("milestone-sheet");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("add-milestone")).toBeTruthy();
  });

  it("does the same for a savings rule, and closes on Escape", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("open-rule-form"));

    await screen.findByTestId("rule-sheet");
    expect(screen.getByTestId("add-rule")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("rule-sheet")).toBeNull();
  });

  /** The retroactive note travels with the rules, not with the balance. */
  it("keeps the retroactive note beside the rules", async () => {
    mount();
    await screen.findByTestId("savings-rules");

    expect(screen.queryByText(sv["pot.retroactiveNote"])).toBeTruthy();
    fireEvent.click(screen.getByTestId("savings-rules"));
    expect(screen.getByText(sv["pot.retroactiveNote"])).toBeTruthy();
  });
});
