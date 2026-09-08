import { describe, expect, it } from "vitest";
import {
  accrueRule,
  dayMatchesCadence,
  daysUntilAffordable,
  potBalance,
  potSeries,
  potStartDate,
  weeklyRateSek,
  type SavingsRule,
} from "./savings.js";
import { formatSek, parseDecimal } from "../numbers.js";

const rule = (over: Partial<SavingsRule> = {}): SavingsRule => ({
  id: "r1",
  label: "Lunch ute",
  amountSek: 120,
  cadence: "weekday",
  startDate: "2026-03-02",
  endDate: null,
  active: true,
  ...over,
});

describe("cadences", () => {
  // 2026-03-02 is a Monday, 2026-03-07 a Saturday, 2026-03-08 a Sunday.
  it("counts every day for every_day", () => {
    expect(dayMatchesCadence("2026-03-07", "every_day")).toBe(true);
    expect(dayMatchesCadence("2026-03-02", "every_day")).toBe(true);
  });

  it("separates weekdays from weekend days", () => {
    expect(dayMatchesCadence("2026-03-02", "weekday")).toBe(true);
    expect(dayMatchesCadence("2026-03-07", "weekday")).toBe(false);
    expect(dayMatchesCadence("2026-03-08", "weekend_day")).toBe(true);
    expect(dayMatchesCadence("2026-03-02", "weekend_day")).toBe(false);
  });

  /** per_event never accrues by the calendar: the event is the thing counted. */
  it("never accrues per_event by the calendar", () => {
    expect(dayMatchesCadence("2026-03-02", "per_event")).toBe(false);
    expect(accrueRule(rule({ cadence: "per_event" }), [], "2026-12-31").accruedSek).toBe(0);
  });
});

describe("accruing one rule", () => {
  it("counts the matching days between the start and today", () => {
    // Mon 2nd to Fri 6th: five weekdays.
    const accrual = accrueRule(rule(), [], "2026-03-06");
    expect(accrual.eligibleDays).toBe(5);
    expect(accrual.accruedSek).toBe(600);
  });

  it("subtracts a day you did buy the thing after all", () => {
    const accrual = accrueRule(
      rule(),
      [{ ruleId: "r1", localDate: "2026-03-04" }],
      "2026-03-06",
    );
    expect(accrual.offsetDays).toBe(1);
    expect(accrual.accruedSek).toBe(480);
  });

  /**
   * An offset filed against a day the rule never counted is not a deduction.
   * Otherwise a Saturday offset on a weekday rule would quietly remove 120 kr
   * that was never accrued.
   */
  it("ignores an offset on a day the cadence never matched", () => {
    const accrual = accrueRule(
      rule(),
      [{ ruleId: "r1", localDate: "2026-03-07" }],
      "2026-03-06",
    );
    expect(accrual.offsetDays).toBe(0);
    expect(accrual.accruedSek).toBe(600);
  });

  it("ignores an offset belonging to another rule", () => {
    const accrual = accrueRule(
      rule(),
      [{ ruleId: "other", localDate: "2026-03-04" }],
      "2026-03-06",
    );
    expect(accrual.offsetDays).toBe(0);
  });

  it("stops at the rule's end date rather than running forever", () => {
    const ended = accrueRule(rule({ endDate: "2026-03-04" }), [], "2026-12-31");
    // Mon, Tue, Wed.
    expect(ended.eligibleDays).toBe(3);
  });

  it("accrues nothing while inactive", () => {
    expect(accrueRule(rule({ active: false }), [], "2026-03-06").accruedSek).toBe(0);
  });

  it("accrues nothing before it starts", () => {
    expect(accrueRule(rule(), [], "2026-03-01").accruedSek).toBe(0);
  });
});

describe("the pot balance", () => {
  const events = [
    { id: "e1", localDate: "2026-03-03", label: "Sålde cykeln", amountSek: 500 },
    { id: "e2", localDate: "2026-03-05", label: "Hörlurar", amountSek: -300 },
  ];

  it("is rules plus one-offs minus payouts", () => {
    const pot = potBalance({ rules: [rule()], offsets: [], events, asOf: "2026-03-06" });

    expect(pot.accruedSek).toBe(600);
    expect(pot.eventsSek).toBe(500);
    expect(pot.paidOutSek).toBe(300);
    expect(pot.balanceSek).toBe(800);
  });

  /**
   * Claiming a reward before the pot covers it is a real thing people do.
   * Clamping to zero would hide a debt they chose to take on.
   */
  it("goes negative rather than clamping at zero", () => {
    const pot = potBalance({
      rules: [],
      offsets: [],
      events: [{ id: "e", localDate: "2026-03-01", label: "Klocka", amountSek: -2000 }],
      asOf: "2026-03-06",
    });

    expect(pot.balanceSek).toBe(-2000);
  });

  it("does not count an event dated in the future", () => {
    const pot = potBalance({
      rules: [],
      offsets: [],
      events: [{ id: "e", localDate: "2026-04-01", label: "Framtid", amountSek: 999 }],
      asOf: "2026-03-06",
    });

    expect(pot.balanceSek).toBe(0);
  });

  it("reports each rule separately, so the pot can be explained", () => {
    const pot = potBalance({
      rules: [rule(), rule({ id: "r2", label: "Snus", amountSek: 50, cadence: "every_day" })],
      offsets: [],
      events: [],
      asOf: "2026-03-06",
    });

    expect(pot.perRule).toHaveLength(2);
    expect(pot.perRule[1]!.label).toBe("Snus");
    expect(pot.perRule[1]!.eligibleDays).toBe(5);
  });

  it("is zero with nothing at all, not an error", () => {
    expect(
      potBalance({ rules: [], offsets: [], events: [], asOf: "2026-03-06" }).balanceSek,
    ).toBe(0);
  });
});

describe("the pot over time", () => {
  it("climbs day by day", () => {
    const series = potSeries({
      rules: [rule({ cadence: "every_day", amountSek: 100 })],
      offsets: [],
      events: [],
      from: "2026-03-02",
      to: "2026-03-05",
    });

    expect(series.map((point) => point.balanceSek)).toEqual([100, 200, 300, 400]);
  });

  it("dips on the day a reward is paid out", () => {
    const series = potSeries({
      rules: [rule({ cadence: "every_day", amountSek: 100 })],
      offsets: [],
      events: [{ id: "e", localDate: "2026-03-04", label: "Skor", amountSek: -250 }],
      from: "2026-03-02",
      to: "2026-03-05",
    });

    expect(series.map((point) => point.balanceSek)).toEqual([100, 200, 50, 150]);
  });

  it("starts at the earliest rule or event", () => {
    expect(
      potStartDate([rule()], [{ id: "e", localDate: "2026-01-01", label: "x", amountSek: 1 }]),
    ).toBe("2026-01-01");
    expect(potStartDate([], [])).toBeNull();
  });
});

describe("how fast the pot fills", () => {
  it("counts a real week rather than assuming five and two", () => {
    expect(weeklyRateSek(rule({ cadence: "weekday", amountSek: 120 }))).toBe(600);
    expect(weeklyRateSek(rule({ cadence: "weekend_day", amountSek: 120 }))).toBe(240);
    expect(weeklyRateSek(rule({ cadence: "every_day", amountSek: 100 }))).toBe(700);
  });

  it("is zero for per_event, which has no rate", () => {
    expect(weeklyRateSek(rule({ cadence: "per_event" }))).toBe(0);
  });

  it("says how long until a reward is covered", () => {
    expect(daysUntilAffordable(0, 600, 600)).toBe(7);
    expect(daysUntilAffordable(300, 600, 600)).toBe(4);
  });

  it("is already affordable at zero days", () => {
    expect(daysUntilAffordable(700, 600, 600)).toBe(0);
  });

  /** No rate means no date, rather than a date infinitely far away. */
  it("cannot say when nothing is accruing", () => {
    expect(daysUntilAffordable(0, 600, 0)).toBeNull();
  });
});

/**
 * Money goes through the same parser and formatter as every other number
 * (D26): one parser for input, one formatter for display, no exceptions.
 */
describe("money in and out", () => {
  it("accepts a Swedish decimal comma", () => {
    const parsed = parseDecimal("120,50");
    expect(parsed.ok && parsed.value).toBe(120.5);
  });

  it("accepts a grouped amount", () => {
    const parsed = parseDecimal("1 200,50");
    expect(parsed.ok && parsed.value).toBe(1200.5);
  });

  it("refuses an ambiguous amount rather than guessing", () => {
    const parsed = parseDecimal("1,200");
    expect(parsed.ok).toBe(false);
  });

  it("formats with a Swedish thousands separator and no stray decimals", () => {
    expect(formatSek(1200)).toMatch(/1\s?200/);
    expect(formatSek(1200)).not.toContain(",00");
  });

  it("formats a negative balance plainly, with a minus", () => {
    expect(formatSek(-350)).toContain("350");
    expect(formatSek(-350)).toMatch(/^[-−]/);
  });

  it("keeps öre when there are any", () => {
    expect(formatSek(120.5)).toContain("50");
  });
});
