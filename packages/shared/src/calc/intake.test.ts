import { describe, expect, it } from "vitest";
import { buildIntakeIndex, coverageOver, hasIntakeOn, intakeOn } from "./intake.js";

/**
 * The single definition of a day's intake. Phase 3 adds food entries to the
 * input of this function and must not fork it, so the precedence rules are
 * pinned here rather than discovered later.
 */
describe("resolving a day's intake", () => {
  it("uses the manual row when there is one", () => {
    const index = buildIntakeIndex({ manual: [{ localDate: "2026-01-01", kcal: 2100 }] });
    expect(intakeOn(index, "2026-01-01")).toBe(2100);
  });

  it("sums the day's food entries when there is no manual row", () => {
    const index = buildIntakeIndex({
      foodEntries: [
        { localDate: "2026-01-01", kcal: 500 },
        { localDate: "2026-01-01", kcal: 250 },
        { localDate: "2026-01-02", kcal: 900 },
      ],
    });
    expect(intakeOn(index, "2026-01-01")).toBe(750);
    expect(intakeOn(index, "2026-01-02")).toBe(900);
  });

  it("lets the manual row override the food entries for that day", () => {
    const index = buildIntakeIndex({
      manual: [{ localDate: "2026-01-01", kcal: 2100 }],
      foodEntries: [
        { localDate: "2026-01-01", kcal: 500 },
        { localDate: "2026-01-02", kcal: 900 },
      ],
    });
    expect(intakeOn(index, "2026-01-01")).toBe(2100);
    // ...and only for that day.
    expect(intakeOn(index, "2026-01-02")).toBe(900);
  });

  it("returns null for a day with nothing logged", () => {
    const index = buildIntakeIndex({ manual: [{ localDate: "2026-01-01", kcal: 2100 }] });
    expect(intakeOn(index, "2026-01-02")).toBeNull();
    expect(hasIntakeOn(index, "2026-01-02")).toBe(false);
  });

  /**
   * The distinction the whole file exists for. A fast is a logged day worth 0
   * kcal; an unlogged day is not a day of eating nothing. Confusing them drags
   * `meanIntake` down and the TDEE estimate with it — see D19.
   */
  it("treats a logged 0 kcal as present, not as missing", () => {
    const index = buildIntakeIndex({ manual: [{ localDate: "2026-01-01", kcal: 0 }] });
    expect(intakeOn(index, "2026-01-01")).toBe(0);
    expect(hasIntakeOn(index, "2026-01-01")).toBe(true);
  });

  it("treats a 0 kcal food entry as present too", () => {
    const index = buildIntakeIndex({
      foodEntries: [{ localDate: "2026-01-01", kcal: 0 }],
    });
    expect(hasIntakeOn(index, "2026-01-01")).toBe(true);
  });

  it("ignores non-finite values rather than poisoning the total", () => {
    const index = buildIntakeIndex({
      manual: [{ localDate: "2026-01-01", kcal: Number.NaN }],
      foodEntries: [{ localDate: "2026-01-02", kcal: Number.POSITIVE_INFINITY }],
    });
    expect(hasIntakeOn(index, "2026-01-01")).toBe(false);
    expect(hasIntakeOn(index, "2026-01-02")).toBe(false);
  });
});

describe("coverage over a window", () => {
  const index = buildIntakeIndex({
    manual: [
      { localDate: "2026-01-01", kcal: 2000 },
      { localDate: "2026-01-03", kcal: 2200 },
    ],
  });
  const window = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];

  it("counts days with a resolved value", () => {
    expect(coverageOver(index, window)).toMatchObject({
      daysWithIntake: 2,
      daysInWindow: 4,
      coverage: 0.5,
    });
  });

  it("sums only the logged days", () => {
    expect(coverageOver(index, window).totalLoggedKcal).toBe(4200);
  });

  it("is zero for an empty window rather than NaN", () => {
    expect(coverageOver(index, [])).toMatchObject({ coverage: 0, daysInWindow: 0 });
  });

  it("counts a 0 kcal day towards coverage", () => {
    const withFast = buildIntakeIndex({
      manual: [
        { localDate: "2026-01-01", kcal: 2000 },
        { localDate: "2026-01-02", kcal: 0 },
      ],
    });
    expect(coverageOver(withFast, ["2026-01-01", "2026-01-02"])).toMatchObject({
      daysWithIntake: 2,
      coverage: 1,
      totalLoggedKcal: 2000,
    });
  });
});
