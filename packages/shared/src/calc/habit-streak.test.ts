import { describe, expect, it } from "vitest";
import { habitStreak } from "./habit-streak.js";

/**
 * The habit streak (D137).
 *
 * What these pin down is the difference between the three kinds of day. A
 * version that treats an unanswered day as a miss looks right until somebody
 * comes back from a week away to a streak that says 9; a version that counts
 * through unanswered days says 40 for a month of silence, which is the failure
 * D35 caught in the sober counter.
 *
 * Every `asOf` is explicit. Nothing here reads a clock.
 */

const set = (...days: string[]) => new Set(days);

describe("a chain of ticked days", () => {
  it("counts back from today", () => {
    const streak = habitStreak({
      ticked: set("2026-09-09", "2026-09-10", "2026-09-11"),
      answered: set("2026-09-09", "2026-09-10", "2026-09-11"),
      asOf: "2026-09-11",
    });

    expect(streak.days).toBe(3);
    expect(streak.startedOn).toBe("2026-09-09");
    expect(streak.checkedToday).toBe(true);
    expect(streak.basis).toBe("from_first");
  });

  /**
   * Today not being ticked yet does not end anything. The day is not over, and
   * a counter that resets at midnight and recovers at breakfast lies for eight
   * hours every morning. Same rule as the logging streak.
   */
  it("survives a today that has not been ticked yet", () => {
    const streak = habitStreak({
      ticked: set("2026-09-09", "2026-09-10"),
      answered: set("2026-09-09", "2026-09-10"),
      asOf: "2026-09-11",
    });

    expect(streak.days).toBe(2);
    expect(streak.checkedToday).toBe(false);
  });

  it("is zero when the habit has never been ticked", () => {
    const streak = habitStreak({
      ticked: set(),
      answered: set("2026-09-10", "2026-09-11"),
      asOf: "2026-09-11",
    });

    expect(streak).toMatchObject({ days: 0, basis: "no_data", startedOn: null });
  });
});

describe("a day that was answered and not ticked", () => {
  /** §4.6's grace rule: one missed day per rolling seven keeps the chain. */
  it("spends the grace day and keeps going", () => {
    const streak = habitStreak({
      ticked: set("2026-09-08", "2026-09-10", "2026-09-11"),
      // The 9th was answered: other habits were ticked that day.
      answered: set("2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"),
      asOf: "2026-09-11",
    });

    expect(streak.days).toBe(3);
    expect(streak.graceUsed).toBe(1);
    expect(streak.startedOn).toBe("2026-09-08");
  });

  /** Two inside one week is past the budget, and the chain stops there. */
  it("stops when a second miss lands inside the same week", () => {
    const streak = habitStreak({
      ticked: set("2026-09-06", "2026-09-08", "2026-09-10", "2026-09-11"),
      answered: set(
        "2026-09-06",
        "2026-09-07",
        "2026-09-08",
        "2026-09-09",
        "2026-09-10",
        "2026-09-11",
      ),
      asOf: "2026-09-11",
    });

    // Ticked 11th and 10th, the 9th spends the grace day, the 7th is a second
    // miss inside the window and ends it.
    expect(streak.days).toBe(3);
    expect(streak.basis).toBe("running");
    expect(streak.countingFrom).toBe("2026-09-08");
  });
});

describe("a day nobody answered", () => {
  /**
   * The rule this whole type exists for: an unlogged day is **unknown**, not a
   * miss. It does not spend the grace day, and the count does not claim it.
   */
  it("stops the count rather than spending the grace day", () => {
    const streak = habitStreak({
      ticked: set("2026-09-05", "2026-09-06", "2026-09-10", "2026-09-11"),
      // The 7th, 8th and 9th have no answer at all.
      answered: set("2026-09-05", "2026-09-06", "2026-09-10", "2026-09-11"),
      asOf: "2026-09-11",
    });

    expect(streak.days).toBe(2);
    expect(streak.graceUsed).toBe(0);
    expect(streak.basis).toBe("gap");
    // Which is what the screen says: counted since the 10th.
    expect(streak.countingFrom).toBe("2026-09-10");
  });

  /**
   * And the case that made D35 necessary: a month of silence does not read as a
   * month of keeping it up.
   */
  it("does not turn silence into a long streak", () => {
    const streak = habitStreak({
      ticked: set("2026-08-01", "2026-08-02", "2026-08-03"),
      answered: set("2026-08-01", "2026-08-02", "2026-08-03"),
      asOf: "2026-09-11",
    });

    expect(streak.days).toBe(0);
    expect(streak.basis).toBe("gap");
    expect(streak.countingFrom).toBe("2026-09-11");
  });

  /** Yesterday unanswered while today is ticked: the chain is today's alone. */
  it("starts a new chain the day it comes back", () => {
    const streak = habitStreak({
      ticked: set("2026-09-01", "2026-09-11"),
      answered: set("2026-09-01", "2026-09-11"),
      asOf: "2026-09-11",
    });

    expect(streak.days).toBe(1);
    expect(streak.startedOn).toBe("2026-09-11");
  });
});

describe("the first day of all", () => {
  it("is where the walk ends, and it says so", () => {
    const streak = habitStreak({
      ticked: set("2026-09-10", "2026-09-11"),
      answered: set("2026-09-10", "2026-09-11"),
      asOf: "2026-09-11",
    });

    expect(streak.basis).toBe("from_first");
    expect(streak.countingFrom).toBe("2026-09-10");
    expect(streak.days).toBe(2);
  });
});
