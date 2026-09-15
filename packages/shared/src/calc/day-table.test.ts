import { describe, expect, it } from "vitest";
import { buildDayTable, type DayTableDaily, type DayTableInput } from "./day-table.js";
import { estimateTdee } from "./tdee.js";
import { addDays, computeTrend } from "./trend.js";

/**
 * The day table (D167): one row per day, each figure from the calc that owns it.
 */

const START = "2026-08-01";
const PROFILE = {
  sex: "male" as const,
  birthDate: "1980-01-01",
  heightCm: 180,
  activityFactor: 1.4,
};

function input(over: Partial<DayTableInput> = {}): DayTableInput {
  const readings = Array.from({ length: 20 }, (_, i) => ({
    localDate: addDays(START, i),
    weightKg: 90 - i * 0.05,
  }));
  const to = addDays(START, 29);
  const intake = new Map(Array.from({ length: 20 }, (_, i) => [addDays(START, i), 2200] as const));
  return {
    from: START,
    to,
    trend: computeTrend(readings, { to }),
    intake,
    macroDays: new Map(),
    daily: new Map<string, DayTableDaily>(),
    activityMinutes: new Map(),
    waistCm: new Map(),
    profile: PROFILE,
    ...over,
  };
}

describe("the day table", () => {
  it("has one row per day in the range, oldest first", () => {
    const rows = buildDayTable(input());

    expect(rows).toHaveLength(30);
    expect(rows[0]!.localDate).toBe(START);
    expect(rows.at(-1)!.localDate).toBe(addDays(START, 29));
  });

  it("carries the reading on its day and the trend on every day after the first reading", () => {
    const rows = buildDayTable(input());

    expect(rows[0]!.weightKg).toBe(90);
    // No reading after day 19: the weight is absent, the trend is carried.
    expect(rows[25]!.weightKg).toBeNull();
    expect(rows[25]!.trendKg).toBe(rows[19]!.trendKg);
  });

  it("states maintenance exactly as the dashboard would have on that day", () => {
    const data = input();
    const rows = buildDayTable(data);

    for (const index of [0, 13, 20, 29]) {
      const row = rows[index]!;
      const expected = estimateTdee({
        trend: data.trend,
        intake: data.intake,
        asOf: row.localDate,
        profile: PROFILE,
      });
      expect(row.maintenanceKcal).toBe(expected.tdee);
      expect(row.maintenanceSource).toBe(expected.source === "none" ? null : expected.source);
    }
    // Fourteen days of full logging is enough for a measured figure.
    expect(rows[20]!.maintenanceSource).toBe("adaptive");
    expect(rows[0]!.maintenanceSource).toBe("formula");
  });

  it("subtracts maintenance only on a day that has intake", () => {
    const rows = buildDayTable(input());

    expect(rows[5]!.intakeMinusMaintenanceKcal).toBe(2200 - rows[5]!.maintenanceKcal!);
    expect(rows[25]!.intakeKcal).toBeNull();
    expect(rows[25]!.intakeMinusMaintenanceKcal).toBeNull();
  });

  it("has no maintenance without the profile the formula needs, and says nothing is missing as zero", () => {
    const rows = buildDayTable(input({ profile: { ...PROFILE, birthDate: null } }));

    expect(rows[0]!.maintenanceKcal).toBeNull();
    expect(rows[0]!.maintenanceSource).toBeNull();
    expect(rows[0]!.intakeMinusMaintenanceKcal).toBeNull();
  });

  it("marks a partial macro as not complete, and carries the coverage of the day's energy", () => {
    const day = START;
    const rows = buildDayTable(
      input({
        macroDays: new Map([
          [
            day,
            [
              { kcal: 600, proteinG: 40, carbsG: 50, fatG: 20, fiberG: null },
              { kcal: 400, proteinG: null, carbsG: null, fatG: null, fiberG: null },
            ],
          ],
        ]),
      }),
    );

    expect(rows[0]!.protein).toEqual({ grams: 40, complete: false });
    expect(rows[0]!.fiber).toEqual({ grams: null, complete: false });
    expect(rows[0]!.intakeCoverage).toBeCloseTo(0.6, 10);
    // A day with no food entries has no coverage, not zero coverage.
    expect(rows[1]!.intakeCoverage).toBeNull();
  });

  it("puts the daily log, movement and waist on their own day", () => {
    const rows = buildDayTable(
      input({
        daily: new Map([
          [START, { alcoholUnits: 2, steps: 8400, sleepHours: 7.5, energy: 4, mood: 3 }],
        ]),
        activityMinutes: new Map([[START, 45]]),
        waistCm: new Map([[START, 95.5]]),
      }),
    );

    expect(rows[0]).toMatchObject({
      alcoholUnits: 2,
      steps: 8400,
      sleepHours: 7.5,
      energy: 4,
      mood: 3,
      activityMinutes: 45,
      waistCm: 95.5,
    });
    expect(rows[1]).toMatchObject({ alcoholUnits: null, activityMinutes: null, waistCm: null });
  });

  it("is empty for a range that ends before it starts", () => {
    expect(buildDayTable(input({ from: "2026-09-02", to: "2026-09-01" }))).toEqual([]);
  });
});
