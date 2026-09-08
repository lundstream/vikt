import { describe, expect, it } from "vitest";
import {
  buildLoggedDays,
  currentStreak,
  daysSinceLastDrink,
  GRACE_DAYS_PER_WINDOW,
} from "./streak.js";

const days = (...list: string[]) => new Set(list);

describe("the logging streak", () => {
  it("counts consecutive logged days", () => {
    const streak = currentStreak(
      days("2026-03-01", "2026-03-02", "2026-03-03"),
      "2026-03-03",
    );
    expect(streak.days).toBe(3);
    expect(streak.startedOn).toBe("2026-03-01");
  });

  /**
   * Today not being logged yet must not reset the counter. A streak that reads
   * zero from midnight until breakfast lies for eight hours every morning.
   */
  it("does not end because today has not been logged yet", () => {
    const streak = currentStreak(days("2026-03-01", "2026-03-02"), "2026-03-03");
    expect(streak.days).toBe(2);
  });

  it("spends one grace day rather than breaking", () => {
    const streak = currentStreak(
      // 5th missing.
      days("2026-03-03", "2026-03-04", "2026-03-06", "2026-03-07"),
      "2026-03-07",
    );
    expect(streak.days).toBe(4);
    expect(streak.graceUsed).toBe(GRACE_DAYS_PER_WINDOW);
  });

  it("breaks on a second miss inside the same week", () => {
    const streak = currentStreak(
      // 4th and 6th both missing.
      days("2026-03-03", "2026-03-05", "2026-03-07"),
      "2026-03-07",
    );
    expect(streak.days).toBe(2);
  });

  it("allows a second miss once the first has left the window", () => {
    const logged = new Set<string>();
    for (let day = 1; day <= 20; day++) {
      const date = `2026-03-${String(day).padStart(2, "0")}`;
      // Miss the 5th and the 15th: ten days apart, so never two in one week.
      if (day !== 5 && day !== 15) logged.add(date);
    }
    expect(currentStreak(logged, "2026-03-20").days).toBe(18);
  });

  it("is zero with nothing logged", () => {
    expect(currentStreak(days(), "2026-03-07")).toEqual({
      days: 0,
      graceUsed: 0,
      startedOn: null,
    });
  });

  it("counts a day logged in any of the three places", () => {
    const logged = buildLoggedDays({
      weight: [{ localDate: "2026-03-01" }],
      food: [{ localDate: "2026-03-02" }],
      daily: [{ localDate: "2026-03-03" }],
    });
    expect(currentStreak(logged, "2026-03-03").days).toBe(3);
  });

  it("counts a day logged twice only once", () => {
    const logged = buildLoggedDays({
      weight: [{ localDate: "2026-03-01" }],
      daily: [{ localDate: "2026-03-01" }],
    });
    expect(logged.size).toBe(1);
  });
});

/**
 * D35. The counter must not reward not logging, which is what "null or zero
 * means sober" would do: it would grow fastest for the person who deleted the
 * app, and a savings rule keyed on it would pay out for silence.
 */
describe("days since the last drink", () => {
  const series = [
    { localDate: "2026-03-01", alcoholUnits: 3 },
    { localDate: "2026-03-02", alcoholUnits: 0 },
    { localDate: "2026-03-03", alcoholUnits: 0 },
    { localDate: "2026-03-04", alcoholUnits: 0 },
  ];

  it("counts the dry days since a recorded drink", () => {
    const result = daysSinceLastDrink(series, "2026-03-04");
    expect(result.days).toBe(3);
    expect(result.lastDrinkOn).toBe("2026-03-01");
    expect(result.basis).toBe("since_drink");
  });

  it("says it cannot tell when nothing is logged at all", () => {
    const result = daysSinceLastDrink([], "2026-03-04");
    expect(result.days).toBeNull();
    expect(result.basis).toBe("no_data");
  });

  /** The rule that matters: a gap is unknown, not dry. */
  it("stops at an unlogged day rather than counting it as sober", () => {
    const withGap = [
      { localDate: "2026-03-01", alcoholUnits: 3 },
      { localDate: "2026-03-02", alcoholUnits: 0 },
      // 3rd not logged at all.
      { localDate: "2026-03-04", alcoholUnits: 0 },
    ];
    const result = daysSinceLastDrink(withGap, "2026-03-04");

    expect(result.basis).toBe("gap");
    expect(result.days).toBe(1);
    expect(result.countingFrom).toBe("2026-03-04");
  });

  it("treats a logged day with a blank alcohol field as a gap too", () => {
    const blank = [
      { localDate: "2026-03-01", alcoholUnits: 3 },
      { localDate: "2026-03-02", alcoholUnits: 0 },
      { localDate: "2026-03-03", alcoholUnits: null },
      { localDate: "2026-03-04", alcoholUnits: 0 },
    ];
    const result = daysSinceLastDrink(blank, "2026-03-04");

    expect(result.basis).toBe("gap");
    expect(result.days).toBe(1);
  });

  it("counts through gaps when the user opts into that reading", () => {
    const withGap = [
      { localDate: "2026-03-01", alcoholUnits: 3 },
      { localDate: "2026-03-02", alcoholUnits: 0 },
      { localDate: "2026-03-04", alcoholUnits: 0 },
    ];
    const result = daysSinceLastDrink(withGap, "2026-03-04", "assumeSober");

    expect(result.basis).toBe("since_drink");
    expect(result.days).toBe(3);
    expect(result.rule).toBe("assumeSober");
  });

  it("always reports which rule produced the number", () => {
    expect(daysSinceLastDrink(series, "2026-03-04").rule).toBe("strict");
    expect(daysSinceLastDrink(series, "2026-03-04", "assumeSober").rule).toBe("assumeSober");
  });

  it("says every logged day is dry when no drink was ever recorded", () => {
    const dry = [
      { localDate: "2026-03-02", alcoholUnits: 0 },
      { localDate: "2026-03-03", alcoholUnits: 0 },
      { localDate: "2026-03-04", alcoholUnits: 0 },
    ];
    const result = daysSinceLastDrink(dry, "2026-03-04");

    expect(result.basis).toBe("never_recorded");
    expect(result.days).toBe(3);
    expect(result.countingFrom).toBe("2026-03-02");
  });

  it("returns zero on the day of a drink, not a negative", () => {
    const result = daysSinceLastDrink(
      [{ localDate: "2026-03-04", alcoholUnits: 2 }],
      "2026-03-04",
    );
    expect(result.days).toBe(0);
  });

  /**
   * The specific thing the strict rule is designed to prevent. Someone who logs
   * one dry day and then nothing for a month must not be shown a 30-day count.
   */
  it("does not grow for someone who stopped logging", () => {
    const abandoned = [
      { localDate: "2026-03-01", alcoholUnits: 4 },
      { localDate: "2026-03-02", alcoholUnits: 0 },
    ];
    const result = daysSinceLastDrink(abandoned, "2026-04-01");

    expect(result.basis).toBe("gap");
    expect(result.days).toBe(0);
    // The permissive reading would say 31, a month of credit for one logged
    // day, which is the point.
    expect(daysSinceLastDrink(abandoned, "2026-04-01", "assumeSober").days).toBe(31);
  });
});

/**
 * D44. A run that started before the app did.
 *
 * The counter can only be built from `daily_log` rows, so someone eighty days
 * sober when they install this has nothing to build it from. Telling them to
 * backfill eighty days to see a number they already know is how a feature goes
 * unused. One date on the profile replaces all of it.
 */
describe("the seeded last-drink date", () => {
  it("counts from the seed with no daily logs at all", () => {
    const result = daysSinceLastDrink([], "2026-03-31", {
      seedLastDrinkOn: "2026-01-10",
    });

    expect(result.basis).toBe("seeded");
    expect(result.days).toBe(80);
    expect(result.lastDrinkOn).toBe("2026-01-10");
    expect(result.countingFrom).toBe("2026-01-11");
  });

  /** A recorded fact beats a remembered one. */
  it("is overridden by a drink logged after it", () => {
    const result = daysSinceLastDrink(
      [
        { localDate: "2026-03-01", alcoholUnits: 3 },
        { localDate: "2026-03-02", alcoholUnits: 0 },
        { localDate: "2026-03-03", alcoholUnits: 0 },
        { localDate: "2026-03-04", alcoholUnits: 0 },
      ],
      "2026-03-04",
      { seedLastDrinkOn: "2026-01-10" },
    );

    expect(result.basis).toBe("since_drink");
    expect(result.lastDrinkOn).toBe("2026-03-01");
    expect(result.days).toBe(3);
  });

  /**
   * And it survives the gap that would otherwise stop a strict count, because
   * the days before the first log are covered by the seed rather than unknown.
   */
  it("carries a strict count back past the first logged day", () => {
    const result = daysSinceLastDrink(
      [
        { localDate: "2026-03-30", alcoholUnits: 0 },
        { localDate: "2026-03-31", alcoholUnits: 0 },
      ],
      "2026-03-31",
      { seedLastDrinkOn: "2026-01-10" },
    );

    expect(result.basis).toBe("seeded");
    expect(result.days).toBe(80);
  });

  /** A gap *after* the seed still stops a strict count: the seed is a floor,
   * not a licence to assume the days in between. */
  it("still reports a gap when a logged stretch has a hole in it", () => {
    const result = daysSinceLastDrink(
      [
        { localDate: "2026-03-01", alcoholUnits: 0 },
        // 2nd and 3rd unlogged.
        { localDate: "2026-03-04", alcoholUnits: 0 },
      ],
      "2026-03-04",
      { seedLastDrinkOn: "2026-01-10", rule: "strict" },
    );

    expect(result.basis).toBe("gap");
  });

  it("lets the permissive rule count through that gap", () => {
    const result = daysSinceLastDrink(
      [
        { localDate: "2026-03-01", alcoholUnits: 0 },
        { localDate: "2026-03-04", alcoholUnits: 0 },
      ],
      "2026-03-04",
      { seedLastDrinkOn: "2026-01-10", rule: "assumeSober" },
    );

    expect(result.basis).toBe("seeded");
    // 10 Jan to 4 Mar: 21 + 28 + 4.
    expect(result.days).toBe(53);
  });

  it("ignores a drink logged before the seed, which is the later statement", () => {
    const result = daysSinceLastDrink(
      [{ localDate: "2026-01-05", alcoholUnits: 4 }],
      "2026-03-31",
      { seedLastDrinkOn: "2026-01-10" },
    );

    expect(result.basis).toBe("seeded");
    expect(result.lastDrinkOn).toBe("2026-01-10");
  });

  it("ignores a seed dated in the future", () => {
    const result = daysSinceLastDrink([], "2026-03-01", {
      seedLastDrinkOn: "2026-06-01",
    });

    expect(result.basis).toBe("no_data");
  });

  it("still takes the rule as a bare string, as it always did", () => {
    expect(daysSinceLastDrink([], "2026-03-01", "assumeSober").rule).toBe("assumeSober");
  });
});
