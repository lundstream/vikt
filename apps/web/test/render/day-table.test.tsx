/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DayTableResponse } from "shared";
import { DayTable } from "../../src/components/DayTable.js";

/**
 * The day table (D167): sortable by any column, "minst" where a macro is
 * partial, an empty cell for anything not filled in, and its own scrolling
 * region so the page never scrolls sideways.
 */

afterEach(cleanup);

type Row = DayTableResponse["rows"][number];

const macro = (grams: number | null, complete = true) => ({ grams, complete });

const row = (over: Partial<Row>): Row => ({
  localDate: "2026-09-01",
  weightKg: null,
  trendKg: null,
  intakeKcal: null,
  intakeCoverage: null,
  protein: macro(null, false),
  carbs: macro(null, false),
  fat: macro(null, false),
  fiber: macro(null, false),
  alcoholUnits: null,
  activityMinutes: null,
  steps: null,
  sleepHours: null,
  energy: null,
  mood: null,
  waistCm: null,
  maintenanceKcal: null,
  maintenanceSource: null,
  intakeMinusMaintenanceKcal: null,
  ...over,
});

const ROWS: Row[] = [
  row({ localDate: "2026-09-01", weightKg: 88.4, trendKg: 88.9, steps: 9000 }),
  row({
    localDate: "2026-09-02",
    weightKg: null,
    trendKg: 88.8,
    intakeKcal: 2100,
    intakeCoverage: 0.6,
    protein: macro(40, false),
    carbs: macro(210, true),
    maintenanceKcal: 2480,
    maintenanceSource: "adaptive",
    intakeMinusMaintenanceKcal: -380,
  }),
  row({ localDate: "2026-09-03", weightKg: 88.1, trendKg: 88.7, maintenanceKcal: 2400, maintenanceSource: "formula" }),
];

const dates = () =>
  screen.getAllByTestId(/^day-row-/).map((element) => element.getAttribute("data-testid")!.replace("day-row-", ""));

const cell = (date: string, column: string) =>
  within(screen.getByTestId(`day-row-${date}`)).getByText((_, element) => element?.getAttribute("data-column") === column, {
    selector: "td",
  });

describe("the day table", () => {
  it("lists the newest day first", () => {
    render(<DayTable rows={ROWS} />);
    expect(dates()).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
  });

  it("sorts by weight ascending on a click, with days that have none last, and descending on the next", () => {
    render(<DayTable rows={ROWS} />);

    fireEvent.click(screen.getByTestId("sort-weight"));
    expect(dates()).toEqual(["2026-09-03", "2026-09-01", "2026-09-02"]);
    expect(screen.getByTestId("sort-weight").closest("th")!.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(screen.getByTestId("sort-weight"));
    expect(dates()).toEqual(["2026-09-01", "2026-09-03", "2026-09-02"]);
  });

  it("says minst in Sten for a partial macro and prints a complete one plainly", () => {
    render(<DayTable rows={ROWS} />);

    const protein = cell("2026-09-02", "protein");
    expect(protein.textContent).toBe("minst 40");
    expect(protein.querySelector(".figure-partial")).not.toBeNull();
    expect(cell("2026-09-02", "carbs").textContent).toBe("210");
  });

  it("leaves a figure that is not filled in empty, never zero and never a dash", () => {
    render(<DayTable rows={ROWS} />);

    expect(cell("2026-09-01", "intake").textContent).toBe("");
    expect(cell("2026-09-01", "maintenance").textContent).toBe("");
    expect(screen.getByTestId("day-table").textContent).not.toMatch(/[–—]/);
  });

  it("names maintenance's source and signs the difference", () => {
    render(<DayTable rows={ROWS} />);

    expect(cell("2026-09-02", "maintenance").textContent).toContain("uppmätt");
    expect(cell("2026-09-03", "maintenance").textContent).toContain("formel");
    expect(cell("2026-09-02", "balance").textContent).toMatch(/^−380$/);
    expect(cell("2026-09-02", "intake").textContent).toContain("60 % med uppgifter");
  });

  it("scrolls sideways in its own labelled, focusable region", () => {
    render(<DayTable rows={ROWS} />);

    const region = screen.getByTestId("day-table-region");
    expect(region.className).toContain("overflow-x-auto");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});
