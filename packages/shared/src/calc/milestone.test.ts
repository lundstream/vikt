import { describe, expect, it } from "vitest";
import {
  checkMilestoneTarget,
  closeThreshold,
  hasReached,
  METRIC_DIRECTION,
  METRIC_UNIT,
  milestoneStatus,
  newlyReached,
  progressToward,
} from "./milestone.js";
import { addDays, computeTrend, TREND_ALPHA } from "./trend.js";
import { MEASUREMENT_RANGE_CM } from "./measurements.js";

describe("reaching a target", () => {
  it("counts down for the metrics that go down", () => {
    expect(hasReached("weight_kg", 99, 100)).toBe(true);
    expect(hasReached("weight_kg", 101, 100)).toBe(false);
    expect(hasReached("waist_cm", 89.5, 90)).toBe(true);
  });

  it("counts up for the metrics that go up", () => {
    expect(hasReached("log_streak_days", 31, 30)).toBe(true);
    expect(hasReached("log_streak_days", 29, 30)).toBe(false);
    expect(hasReached("sober_days", 30, 30)).toBe(true);
  });

  it("treats exactly on target as reached", () => {
    expect(hasReached("weight_kg", 100, 100)).toBe(true);
  });

  /**
   * Direction is declared, not inferred from the current value. Inferring it
   * would make "waist 90" mean opposite things depending on where the user was
   * standing when they created it.
   */
  it("declares a direction for every metric", () => {
    for (const metric of Object.keys(METRIC_DIRECTION) as (keyof typeof METRIC_DIRECTION)[]) {
      expect(["up", "down"]).toContain(METRIC_DIRECTION[metric]);
    }
  });
});

describe("progress toward a target", () => {
  it("is the fraction of the way from the start", () => {
    expect(
      progressToward({
        metric: "weight_kg",
        startValue: 110,
        currentValue: 105,
        targetValue: 100,
      }),
    ).toBeCloseTo(0.5, 6);
  });

  it("clamps past the target rather than exceeding one", () => {
    expect(
      progressToward({
        metric: "weight_kg",
        startValue: 110,
        currentValue: 95,
        targetValue: 100,
      }),
    ).toBe(1);
  });

  it("clamps at zero when the metric moved the wrong way", () => {
    expect(
      progressToward({
        metric: "weight_kg",
        startValue: 110,
        currentValue: 115,
        targetValue: 100,
      }),
    ).toBe(0);
  });

  it("is absent without a starting point", () => {
    expect(
      progressToward({
        metric: "weight_kg",
        startValue: null,
        currentValue: 105,
        targetValue: 100,
      }),
    ).toBeNull();
  });
});

/**
 * D36. The EMA lags a steadily falling series by about nine days at daily
 * cadence, so the scale shows the target well before the trend crosses it.
 * That lag is correct; being silent about it is not.
 */
describe("the close-to-it state", () => {
  it("reports achieved first, whatever the current values say", () => {
    const status = milestoneStatus({
      metric: "weight_kg",
      targetValue: 100,
      achievedAt: "2026-02-01T08:00:00Z",
      trendValue: 104,
      rawValue: 105,
    });

    // The trend has risen back above it. It still happened.
    expect(status.state).toBe("achieved");
  });

  it("says the scale has been there while the trend has not", () => {
    const status = milestoneStatus({
      metric: "weight_kg",
      targetValue: 100,
      achievedAt: null,
      trendValue: 100.8,
      rawValue: 99.6,
    });

    expect(status.state).toBe("raw_reached");
    if (status.state !== "raw_reached") return;
    expect(status.remaining).toBeCloseTo(0.8, 6);
  });

  it("calls it close when the trend is nearly there", () => {
    const status = milestoneStatus({
      metric: "weight_kg",
      targetValue: 100,
      achievedAt: null,
      trendValue: 100.4,
      rawValue: 100.5,
    });

    expect(status.state).toBe("close");
  });

  it("is open when it is still a way off", () => {
    const status = milestoneStatus({
      metric: "weight_kg",
      targetValue: 100,
      achievedAt: null,
      trendValue: 106,
      rawValue: 105.8,
    });

    expect(status.state).toBe("open");
    if (status.state !== "open") return;
    expect(status.remaining).toBeCloseTo(6, 6);
  });

  it("is open with no readings at all rather than close to everything", () => {
    const status = milestoneStatus({
      metric: "weight_kg",
      targetValue: 100,
      achievedAt: null,
      trendValue: null,
      rawValue: null,
    });

    expect(status.state).toBe("open");
    if (status.state !== "open") return;
    expect(status.remaining).toBeNull();
  });

  it("scales the close band to the metric, not to a single absolute", () => {
    expect(closeThreshold("whtr", 0.5)).toBeLessThan(0.02);
    expect(closeThreshold("weight_kg", 100)).toBeGreaterThan(0.5);
    // Capped, so a large target does not make "close" absurdly wide.
    expect(closeThreshold("weight_kg", 500)).toBe(1.5);
  });

  /**
   * The lag this state exists for, demonstrated rather than asserted from
   * theory: a real falling series where the raw reading crosses days before
   * the smoothed one does.
   */
  it("fires raw_reached during the real lag of a falling series", () => {
    // Long enough that the smoothed line also gets there: at 0.1 kg a day the
    // raw series crosses 100 on day 21 and the trend needs its ~9 day lag.
    const readings = Array.from({ length: 45 }, (_, day) => ({
      localDate: addDays("2026-03-01", day),
      weightKg: 102 - day * 0.1,
    }));

    const trend = computeTrend(readings);
    const target = 100;

    const rawCrossed = readings.findIndex((r) => r.weightKg <= target);
    const trendCrossed = trend.findIndex((point) => point.trend <= target);

    expect(rawCrossed).toBeGreaterThanOrEqual(0);
    // The smoothed line crosses later, which is the whole reason for the state.
    expect(trendCrossed).toBeGreaterThan(rawCrossed);

    const atRawCross = milestoneStatus({
      metric: "weight_kg",
      targetValue: target,
      achievedAt: null,
      trendValue: trend[rawCrossed]!.trend,
      rawValue: readings[rawCrossed]!.weightKg,
    });
    expect(atRawCross.state).toBe("raw_reached");
  });

  it("lags by roughly the documented amount at daily cadence", () => {
    // (1 - alpha)/alpha = 9 days at alpha = 0.1.
    expect((1 - TREND_ALPHA) / TREND_ALPHA).toBeCloseTo(9, 6);
  });
});

/**
 * Detection runs on the trend, never the raw reading, and achievement is
 * permanent once stamped.
 */
describe("newly reached milestones", () => {
  const milestones = [
    { id: "a", metric: "weight_kg" as const, targetValue: 100, achievedAt: null },
    { id: "b", metric: "weight_kg" as const, targetValue: 95, achievedAt: null },
    { id: "c", metric: "waist_cm" as const, targetValue: 90, achievedAt: null },
  ];

  it("returns the ones the trend has crossed", () => {
    expect(newlyReached(milestones, "weight_kg", 99).map((m) => m.id)).toEqual(["a"]);
  });

  it("returns several at once when a gap crosses more than one", () => {
    expect(newlyReached(milestones, "weight_kg", 94).map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("leaves other metrics alone", () => {
    expect(newlyReached(milestones, "weight_kg", 50).map((m) => m.id)).toEqual(["a", "b"]);
  });

  /** Re-stamping would move `achievedAt` and re-fire the celebration. */
  it("never returns an already-achieved milestone", () => {
    const stamped = [{ ...milestones[0]!, achievedAt: "2026-01-01T00:00:00Z" }];
    expect(newlyReached(stamped, "weight_kg", 99)).toEqual([]);
  });

  it("is empty when nothing has been crossed", () => {
    expect(newlyReached(milestones, "weight_kg", 101)).toEqual([]);
  });

  /**
   * The dehydrated-morning case, stated directly: a raw reading two kilos below
   * the trend must not produce a detection, because detection is never handed
   * the raw value.
   */
  it("does not fire on a single low reading, because it is given the trend", () => {
    const readings = [
      { localDate: "2026-03-01", weightKg: 102 },
      { localDate: "2026-03-02", weightKg: 101.8 },
      // One dehydrated morning.
      { localDate: "2026-03-03", weightKg: 99.4 },
    ];
    const trend = computeTrend(readings).at(-1)!.trend;

    expect(trend).toBeGreaterThan(100);
    expect(newlyReached(milestones, "weight_kg", trend)).toEqual([]);
  });
});

/**
 * A target field with no unit is a field you can get wrong in silence: 95 is a
 * reasonable waist in centimetres, a reasonable weight in kilos, and a nonsense
 * ratio. The metric is chosen in the select beside it, so the unit follows.
 */
describe("metric units", () => {
  it("gives every metric a unit and a band", () => {
    for (const metric of Object.keys(METRIC_DIRECTION) as (keyof typeof METRIC_UNIT)[]) {
      const unit = METRIC_UNIT[metric];
      expect(unit).toBeDefined();
      expect(unit.min).toBeLessThan(unit.max);
      expect(unit.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves waist-to-height without a suffix, because it is a ratio", () => {
    expect(METRIC_UNIT.whtr.suffix).toBe("");
    expect(METRIC_UNIT.weight_kg.suffix).toBe("kg");
    expect(METRIC_UNIT.waist_cm.suffix).toBe("cm");
    expect(METRIC_UNIT.sober_days.suffix).toBe("dagar");
  });

  it("counts days as whole numbers and a ratio to two places", () => {
    expect(METRIC_UNIT.sober_days.decimals).toBe(0);
    expect(METRIC_UNIT.log_streak_days.decimals).toBe(0);
    expect(METRIC_UNIT.whtr.decimals).toBe(2);
  });

  it("agrees with the measurement form about what a waist can be", () => {
    // A milestone must not be settable to a figure the measurement form would
    // itself refuse, or the target would be unreachable by construction.
    expect(METRIC_UNIT.waist_cm.min).toBe(MEASUREMENT_RANGE_CM.waist.min);
    expect(METRIC_UNIT.waist_cm.max).toBe(MEASUREMENT_RANGE_CM.waist.max);
    expect(METRIC_UNIT.chest_cm.min).toBe(MEASUREMENT_RANGE_CM.chest.min);
    expect(METRIC_UNIT.chest_cm.max).toBe(MEASUREMENT_RANGE_CM.chest.max);
  });
});

describe("checkMilestoneTarget", () => {
  it("accepts ordinary targets", () => {
    expect(checkMilestoneTarget("weight_kg", 85).ok).toBe(true);
    expect(checkMilestoneTarget("waist_cm", 95).ok).toBe(true);
    expect(checkMilestoneTarget("whtr", 0.48).ok).toBe(true);
    expect(checkMilestoneTarget("sober_days", 100).ok).toBe(true);
  });

  /** The slipped decimal point, which is what the band is actually for. */
  it("refuses a ratio typed as a percentage", () => {
    expect(checkMilestoneTarget("whtr", 48).ok).toBe(false);
    expect(checkMilestoneTarget("whtr", 0.05).ok).toBe(false);
  });

  it("refuses a weight that is a waist and a waist that is a weight", () => {
    expect(checkMilestoneTarget("weight_kg", 9).ok).toBe(false);
    expect(checkMilestoneTarget("waist_cm", 9).ok).toBe(false);
    expect(checkMilestoneTarget("weight_kg", 950).ok).toBe(false);
  });

  it("returns the band when it refuses, so the message can name it", () => {
    const result = checkMilestoneTarget("whtr", 48);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unit.min).toBe(0.2);
      expect(result.unit.max).toBe(1.5);
    }
  });

  it("refuses a value that is not a number at all", () => {
    expect(checkMilestoneTarget("weight_kg", Number.NaN).ok).toBe(false);
  });

  it("accepts the band's own endpoints", () => {
    expect(checkMilestoneTarget("sober_days", 1).ok).toBe(true);
    expect(checkMilestoneTarget("sober_days", 3650).ok).toBe(true);
    expect(checkMilestoneTarget("sober_days", 0).ok).toBe(false);
  });
});
