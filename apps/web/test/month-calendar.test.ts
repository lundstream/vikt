import { describe, expect, it } from "vitest";
import {
  leadingBlanks,
  monthDays,
  monthOf,
  shiftMonth,
} from "../src/components/MonthCalendar.js";

/**
 * The month arithmetic behind the calendar (D145).
 *
 * Separated from the rendering because all three of these are the kind of
 * mistake that looks right most of the time. A Sunday-first grid is correct one
 * day in seven; a month length that forgets February is correct eleven months
 * in twelve; a month step built by adding to the month number produces
 * "2026-13".
 */

describe("the days in a month", () => {
  it("counts thirty-one, thirty and twenty-eight", () => {
    expect(monthDays("2026-01")).toHaveLength(31);
    expect(monthDays("2026-04")).toHaveLength(30);
    expect(monthDays("2026-02")).toHaveLength(28);
  });

  /** The one the arithmetic gets wrong if it hard-codes a table. */
  it("knows a leap February", () => {
    expect(monthDays("2028-02")).toHaveLength(29);
  });

  it("gives them as dates in order, zero-padded", () => {
    const days = monthDays("2026-09");
    expect(days[0]).toBe("2026-09-01");
    expect(days.at(-1)).toBe("2026-09-30");
  });
});

describe("where the first of the month sits", () => {
  /**
   * Monday first. `getUTCDay()` is Sunday-first, so this is the rotation, and
   * an unrotated grid is off by one column every month without erroring.
   */
  it.each([
    // A Tuesday: one blank before it.
    ["2026-09", 1],
    // A Thursday.
    ["2026-10", 3],
    // A Sunday, which is the last column, so six blanks.
    ["2026-11", 6],
    // A Monday, which is the first column and needs none.
    ["2026-06", 0],
  ])("%s starts after %i blanks", (month, blanks) => {
    expect(leadingBlanks(month)).toBe(blanks);
  });
});

describe("stepping between months", () => {
  it("crosses a year in both directions", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("keeps the padded form", () => {
    expect(shiftMonth("2026-09", 1)).toBe("2026-10");
    expect(shiftMonth("2026-10", -1)).toBe("2026-09");
  });
});

describe("the month a day belongs to", () => {
  it("is the first seven characters, and nothing is parsed to find out", () => {
    expect(monthOf("2026-09-12")).toBe("2026-09");
  });
});
