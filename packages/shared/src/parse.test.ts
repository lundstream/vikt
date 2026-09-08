import { describe, expect, it } from "vitest";
import { toNumber, toNumberOrNull, toNumeric, toNumericOrNull } from "./parse.js";

describe("the numeric boundary", () => {
  it("parses the strings Drizzle returns for numeric columns", () => {
    expect(toNumber("82.40")).toBe(82.4);
    expect(toNumber(82.4)).toBe(82.4);
  });

  it("passes null through", () => {
    expect(toNumberOrNull(null)).toBeNull();
    expect(toNumberOrNull(undefined)).toBeNull();
    expect(toNumericOrNull(null, 2)).toBeNull();
  });

  it("serialises at a fixed scale instead of exponent notation", () => {
    expect(toNumeric(82.4, 2)).toBe("82.40");
    expect(toNumeric(0.0000001, 2)).toBe("0.00");
  });

  it("refuses garbage rather than yielding NaN", () => {
    expect(() => toNumber("")).toThrow();
    expect(() => toNumber("kg")).toThrow();
    expect(() => toNumber(Number.NaN)).toThrow();
  });
});
