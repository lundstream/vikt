import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL,
  MATERIAL_TDEE_CHANGE,
  checkPlanGuardrails,
  impliedRateKgWeek,
  reviewPlan,
} from "./guardrails.js";

/**
 * The rate guardrail is validated once, against a figure designed to change —
 * DECISIONS.md D25. This is what puts the plan back in front of the user.
 */

const base = {
  targetIntakeKcal: 2000,
  intakeFloorKcal: 1500,
  referenceWeightKg: 87,
};

describe("the implied rate", () => {
  it("is the daily deficit expressed per week", () => {
    // 500 kcal/day * 7 / 7700 = 0.4545 kg/week
    expect(impliedRateKgWeek(2500, 2000)).toBeCloseTo(0.4545, 4);
  });

  it("is the number that moved when §4.2 was fixed", () => {
    // The seeded account: 2083 -> 2499 against a 2000 target.
    expect(impliedRateKgWeek(2083, 2000)).toBeCloseTo(0.0755, 4);
    expect(impliedRateKgWeek(2499, 2000)).toBeCloseTo(0.4536, 4);
  });
});

describe("when the plan is put back in front of the user", () => {
  it("does nothing while maintenance is unknown", () => {
    expect(
      reviewPlan({ ...base, currentTdee: null, currentSource: "none" }),
    ).toBeNull();
  });

  it("fires the first time a real figure appears", () => {
    const review = reviewPlan({
      ...base,
      currentTdee: 2499,
      currentSource: "adaptive",
      previousTdee: null,
      previousSource: "none",
    });
    expect(review?.reason).toBe("source_improved");
  });

  it("fires when a plan written against the formula gets a real figure", () => {
    const review = reviewPlan({
      ...base,
      currentTdee: 2499,
      currentSource: "adaptive",
      previousTdee: 2300,
      previousSource: "formula",
    });
    expect(review?.reason).toBe("source_improved");
  });

  it("does not fire again once the plan has been baselined on an adaptive figure", () => {
    expect(
      reviewPlan({
        ...base,
        currentTdee: 2520,
        currentSource: "adaptive",
        previousTdee: 2499,
        previousSource: "adaptive",
      }),
    ).toBeNull();
  });

  it("fires when the adaptive figure moves materially", () => {
    const review = reviewPlan({
      ...base,
      currentTdee: 2499 * (1 + MATERIAL_TDEE_CHANGE),
      currentSource: "adaptive",
      previousTdee: 2499,
      previousSource: "adaptive",
    });
    expect(review?.reason).toBe("tdee_moved");
  });

  it("fires on a material drop as well as a rise", () => {
    const review = reviewPlan({
      ...base,
      currentTdee: 2100,
      currentSource: "adaptive",
      previousTdee: 2499,
      previousSource: "adaptive",
    });
    expect(review?.reason).toBe("tdee_moved");
  });

  it("stays quiet inside the estimate's own error band", () => {
    // ~4.5% is the standard error of the estimate itself (D19). A threshold
    // inside that would fire on sampling, not on anything real.
    for (const drift of [0.01, 0.03, 0.045, 0.09]) {
      expect(
        reviewPlan({
          ...base,
          currentTdee: 2499 * (1 + drift),
          currentSource: "adaptive",
          previousTdee: 2499,
          previousSource: "adaptive",
        }),
        `${drift * 100}% drift`,
      ).toBeNull();
    }
  });

  it("uses 10%, which is about half a day's deficit", () => {
    expect(MATERIAL_TDEE_CHANGE).toBe(0.1);
    expect(2600 * MATERIAL_TDEE_CHANGE).toBeCloseTo(260, 0);
  });
});

describe("what the review tells the user", () => {
  it("reports the rate the plan now implies, not the one it was written with", () => {
    const review = reviewPlan({
      ...base,
      targetRateKgWeek: 0.1,
      currentTdee: 2499,
      currentSource: "adaptive",
      previousTdee: 2083,
      previousSource: "formula",
    });
    expect(review!.plannedRateKgWeek).toBe(0.1);
    expect(review!.impliedRateKgWeek).toBeCloseTo(0.4536, 3);
  });

  it("carries the violations the plan would now fail on", () => {
    // At 60 kg the cap is 0.6 kg/week; a 2600 maintenance against a 1600
    // target implies 0.909, which is too fast.
    const review = reviewPlan({
      targetIntakeKcal: 1600,
      intakeFloorKcal: 1500,
      referenceWeightKg: 60,
      currentTdee: 2600,
      currentSource: "adaptive",
      previousTdee: null,
      previousSource: "none",
    });
    expect(review!.violations.map((v) => v.code)).toContain("rate_too_fast");
  });

  it("carries no violations when the plan merely changed and is still legal", () => {
    const review = reviewPlan({
      ...base,
      currentTdee: 2499,
      currentSource: "adaptive",
      previousTdee: null,
      previousSource: "none",
    });
    expect(review!.violations).toEqual([]);
  });

  it("never returns a modified plan — only a description", () => {
    const review = reviewPlan({
      ...base,
      currentTdee: 2499,
      currentSource: "adaptive",
      previousSource: "none",
    });
    expect(review).not.toHaveProperty("targetIntakeKcal");
    expect(Object.keys(review!).sort()).toEqual([
      "currentTdee",
      "impliedRateKgWeek",
      "plannedRateKgWeek",
      "previousTdee",
      "reason",
      "violations",
    ]);
  });
});

describe("the system floor in the guardrail check", () => {
  it("takes the higher of the two floors", () => {
    const violations = checkPlanGuardrails({
      targetIntakeKcal: 1000,
      intakeFloorKcal: 800,
    });
    expect(violations[0]!.code).toBe("intake_below_system_floor");
  });

  it("reports the user's own floor when that is the binding one", () => {
    const violations = checkPlanGuardrails({
      targetIntakeKcal: 1400,
      intakeFloorKcal: 1600,
    });
    expect(violations[0]!.code).toBe("intake_below_floor");
  });

  it("honours an instance override", () => {
    expect(
      checkPlanGuardrails({
        targetIntakeKcal: 1000,
        intakeFloorKcal: 800,
        systemFloorKcal: 900,
      }),
    ).toEqual([]);
  });

  it("defaults to 1200", () => {
    expect(DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL).toBe(1200);
  });
});
