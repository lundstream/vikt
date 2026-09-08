import { describe, expect, it } from "vitest";
import { computeSeriesTrend } from "./trend.js";
import { bmi, BMI_BANDS, bmiBand, latestBmi } from "./bmi.js";

describe("bmi", () => {
  it("is kg over metres squared", () => {
    expect(bmi(80, 180)).toBeCloseTo(24.69, 2);
    expect(bmi(100, 200)).toBe(25);
  });

  it("is absent rather than wrong when an input is missing", () => {
    expect(bmi(null, 180)).toBeNull();
    expect(bmi(80, null)).toBeNull();
    expect(bmi(80, 0)).toBeNull();
    expect(bmi(Number.NaN, 180)).toBeNull();
  });

  it("keeps the cut-offs as constants, not as literals in a component", () => {
    expect(BMI_BANDS.normal).toBe(25);
    expect(bmiBand(18.4)).toBe("underweight");
    expect(bmiBand(22)).toBe("normal");
    expect(bmiBand(27)).toBe("overweight");
    expect(bmiBand(31)).toBe("obese");
    expect(bmiBand(null)).toBeNull();
  });

  it("puts a boundary value in the higher band, once", () => {
    expect(bmiBand(18.5)).toBe("normal");
    expect(bmiBand(25)).toBe("overweight");
    expect(bmiBand(30)).toBe("obese");
  });
});

describe("latestBmi", () => {
  const readings = [
    { localDate: "2026-08-25", value: 92.4 },
    { localDate: "2026-08-26", value: 91.1 },
    { localDate: "2026-08-27", value: 92.0 },
    // A dehydrated morning. The point of smoothing first.
    { localDate: "2026-08-28", value: 89.6 },
  ];

  it("uses the smoothed value, not the last reading", () => {
    const trend = computeSeriesTrend(readings);
    const value = latestBmi(trend, 180);

    expect(value).not.toBeNull();
    expect(value).toBeCloseTo(bmi(trend.at(-1)!.trend, 180)!, 10);
    // The raw reading would have given a visibly lower figure.
    expect(value).toBeGreaterThan(bmi(89.6, 180)!);
  });

  it("is absent with no readings", () => {
    expect(latestBmi([], 180)).toBeNull();
  });
});
