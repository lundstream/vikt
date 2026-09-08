import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TYPES,
  activityKcal,
  buildActivityIndex,
  exerciseAdjustment,
  metFor,
} from "./activity.js";

describe("MET values", () => {
  it("rises with intensity within a type", () => {
    const values = [1, 2, 3, 4, 5].map((level) => metFor("run", level));
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it("falls back to the generic band for an unknown type", () => {
    expect(metFor("kitesurfing", 3)).toBe(metFor("other", 3));
  });

  it("uses the middle band when intensity is missing, rather than the lowest", () => {
    expect(metFor("cycle", null)).toBe(metFor("cycle", 3));
    expect(metFor("cycle", undefined)).toBe(metFor("cycle", 3));
  });

  it("clamps an out-of-range intensity instead of returning undefined", () => {
    expect(metFor("walk", 0)).toBe(metFor("walk", 1));
    expect(metFor("walk", 99)).toBe(metFor("walk", 5));
    expect(metFor("walk", Number.NaN)).toBe(metFor("walk", 3));
  });

  it("has a band for every listed type", () => {
    for (const type of ACTIVITY_TYPES) {
      expect(metFor(type, 3)).toBeGreaterThan(0);
    }
  });
});

describe("the kcal estimate", () => {
  it("follows the ACSM form", () => {
    // 7 MET, 80 kg, 60 min: 7 * 3.5 * 80 / 200 * 60 = 588
    expect(activityKcal({ type: "cycle", durationMin: 60, intensity: 3, weightKg: 80 })).toBe(
      588,
    );
  });

  it("scales linearly with duration and weight", () => {
    const base = activityKcal({ type: "run", durationMin: 30, intensity: 3, weightKg: 80 })!;
    expect(activityKcal({ type: "run", durationMin: 60, intensity: 3, weightKg: 80 })).toBe(
      base * 2,
    );
    expect(activityKcal({ type: "run", durationMin: 30, intensity: 3, weightKg: 160 })).toBe(
      base * 2,
    );
  });

  /** D20's rule: a visibly absent number beats a quietly assumed one. */
  it("is absent without a body weight, rather than assuming one", () => {
    expect(activityKcal({ type: "run", durationMin: 30, intensity: 3, weightKg: null })).toBeNull();
  });

  it("is absent for a zero or negative duration", () => {
    expect(activityKcal({ type: "run", durationMin: 0, intensity: 3, weightKg: 80 })).toBeNull();
    expect(activityKcal({ type: "run", durationMin: -5, intensity: 3, weightKg: 80 })).toBeNull();
  });
});

describe("the daily activity index", () => {
  it("sums several sessions on one day", () => {
    const index = buildActivityIndex([
      { localDate: "2026-03-01", durationMin: 30, kcalEstimate: 300 },
      { localDate: "2026-03-01", durationMin: 45, kcalEstimate: 200 },
    ]);

    expect(index.get("2026-03-01")).toEqual({ minutes: 75, kcal: 500 });
  });

  /** The same rule as intake: absent is not zero. */
  it("leaves a day with no activity absent rather than zero", () => {
    const index = buildActivityIndex([
      { localDate: "2026-03-01", durationMin: 30, kcalEstimate: 300 },
    ]);

    expect(index.has("2026-03-02")).toBe(false);
    expect(index.get("2026-03-02")).toBeUndefined();
  });

  it("keeps kcal null when no session on the day could be estimated", () => {
    const index = buildActivityIndex([
      { localDate: "2026-03-01", durationMin: 30, kcalEstimate: null },
    ]);

    expect(index.get("2026-03-01")).toEqual({ minutes: 30, kcal: null });
  });
});

/**
 * D31. The rule that matters is the first one: adaptive maintenance already
 * contains the training, so the toggle must be *unavailable*, not merely off.
 */
describe("adding exercise to the target", () => {
  it("is unavailable while maintenance is adaptive, whatever the preference says", () => {
    const on = exerciseAdjustment(true, "adaptive");

    expect(on.available).toBe(false);
    expect(on.inForce).toBe(false);
    expect(on.reason).toBe("adaptive_includes_activity");
  });

  it("keeps the stored preference rather than clearing it", () => {
    expect(exerciseAdjustment(true, "adaptive").preference).toBe(true);
    expect(exerciseAdjustment(false, "adaptive").preference).toBe(false);
  });

  it("applies when maintenance comes from the formula", () => {
    const on = exerciseAdjustment(true, "formula");

    expect(on.available).toBe(true);
    expect(on.inForce).toBe(true);
    expect(on.reason).toBe("formula");
  });

  it("is available but not in force when the formula user has it switched off", () => {
    const off = exerciseAdjustment(false, "formula");

    expect(off.available).toBe(true);
    expect(off.inForce).toBe(false);
  });

  it("is unavailable with no maintenance figure at all, because there is nothing to add to", () => {
    const none = exerciseAdjustment(true, "none");

    expect(none.available).toBe(false);
    expect(none.inForce).toBe(false);
    expect(none.reason).toBe("no_maintenance_figure");
  });

  /**
   * The transition that would otherwise bite: someone sets the toggle during
   * their formula weeks, then crosses into adaptive on day 28. Nothing about
   * the stored row changes, and the adjustment must switch itself off.
   */
  it("switches itself off when a formula user crosses into adaptive", () => {
    expect(exerciseAdjustment(true, "formula").inForce).toBe(true);
    expect(exerciseAdjustment(true, "adaptive").inForce).toBe(false);
  });
});
