import { describe, expect, it } from "vitest";
import {
  formatDecimal,
  formatForInput,
  formatKcal,
  formatKg,
  parseDecimal,
  parseDecimalOr,
} from "./numbers.js";

/**
 * `Number("180,0")` is `NaN`, and a comma is what a Swedish numeric keypad
 * produces. Every field in the app used to parse with `Number()`.
 */

const value = (input: string) => {
  const parsed = parseDecimal(input);
  return parsed.ok ? parsed.value : null;
};
const reason = (input: string) => {
  const parsed = parseDecimal(input);
  return parsed.ok ? null : parsed.reason;
};

describe("parsing what a Swedish keyboard produces", () => {
  it("accepts a comma as the decimal separator", () => {
    expect(value("180,0")).toBe(180);
    expect(value("82,45")).toBe(82.45);
    expect(value("0,5")).toBe(0.5);
    expect(value("-0,75")).toBe(-0.75);
  });

  it("still accepts a full stop", () => {
    expect(value("180.0")).toBe(180);
    expect(value("82.45")).toBe(82.45);
  });

  it("accepts plain integers", () => {
    expect(value("1700")).toBe(1700);
    expect(value("0")).toBe(0);
  });

  it("accepts the grouping this app's own formatter emits", () => {
    // toLocaleString("sv-SE") uses a non-breaking space.
    expect(value("2 499")).toBe(2499);
    expect(value("1 234,5")).toBe(1234.5);
    expect(value("1 234,5")).toBe(1234.5);
  });

  it("round-trips its own display output", () => {
    for (const n of [0, 0.5, 87.3, 1700, 2499, 12345.6]) {
      expect(value(formatDecimal(n, { maxDecimals: 4 })), String(n)).toBe(n);
    }
  });

  it("round-trips its own input formatting", () => {
    for (const n of [80, 180.5, 0.5, 2499]) {
      expect(value(formatForInput(n)), String(n)).toBe(n);
    }
  });
});

describe("refusing rather than guessing", () => {
  /**
   * The one genuinely ambiguous shape. To an English reader "1,234" is a
   * thousand; to a Swedish one it is 1.234. Guessing turns a weight into a
   * thousand times itself, which is the sort of thing an app should refuse to
   * do on the user's behalf.
   */
  it("rejects a lone separator with exactly three digits after it", () => {
    expect(reason("1,234")).toBe("ambiguous");
    expect(reason("1.234")).toBe("ambiguous");
    expect(reason("82,450")).toBe("ambiguous");
  });

  it("accepts the same digits when the grouping is unambiguous", () => {
    expect(value("1 234")).toBe(1234);
    expect(value("1.234,5")).toBe(1234.5);
    expect(value("1,234.5")).toBe(1234.5);
  });

  it("rejects a grouping separator after the decimal one", () => {
    expect(reason("1,5.678")).toBe("ambiguous");
  });

  it("rejects more than one decimal separator", () => {
    expect(reason("1,2,3")).toBe("ambiguous");
    expect(reason("82.4.5")).toBe("ambiguous");
  });

  it("accepts repeated separators when they are consistent grouping", () => {
    expect(value("1.234.567")).toBe(1234567);
    expect(value("1,234,567")).toBe(1234567);
  });

  it("rejects text, and says so rather than returning NaN", () => {
    expect(reason("kilo")).toBe("not_a_number");
    expect(reason("80kg")).toBe("not_a_number");
    expect(reason("--5")).toBe("not_a_number");
    expect(reason(",")).toBe("not_a_number");
  });

  it("reports an empty field as empty, not as invalid", () => {
    expect(reason("")).toBe("empty");
    expect(reason("   ")).toBe("empty");
  });

  it("never returns NaN from the convenience wrapper", () => {
    for (const input of ["", "kilo", "1,234", "1,2,3"]) {
      expect(parseDecimalOr(input, null)).toBeNull();
    }
    expect(parseDecimalOr("87,3", null)).toBe(87.3);
  });
});

describe("the fields that were broken", () => {
  it("parses a height typed with a comma", () => {
    expect(value("180,0")).toBe(180);
    expect(value("183,5")).toBe(183.5);
  });

  it("parses a goal weight typed with a comma", () => {
    expect(value("84,0")).toBe(84);
    expect(value("79,5")).toBe(79.5);
  });

  it("parses a planned rate typed with a comma", () => {
    expect(value("0,5")).toBe(0.5);
    expect(value("0,75")).toBe(0.75);
  });

  it("parses a daily target typed with grouping", () => {
    expect(value("1700")).toBe(1700);
    expect(value("2 000")).toBe(2000);
    expect(value("2 499")).toBe(2499);
  });
});

describe("formatting", () => {
  it("groups thousands the Swedish way", () => {
    // sv-SE groups with a non-breaking space, not a comma.
    expect(formatKcal(2499)).toBe("2 499");
    expect(formatKcal(1700)).toBe("1 700");
  });

  it("uses a comma for decimals", () => {
    expect(formatKg(87.3)).toBe("87,3");
    expect(formatKg(180)).toBe("180,0");
  });

  it("formats every number in the app the same way", () => {
    // The complaint that started this: "1700" beside "2 499".
    expect(formatKcal(1700)).toBe("1 700");
    expect(formatKcal(2499)).toBe("2 499");
    expect(formatKcal(1700).includes(" ")).toBe(true);
  });

  it("leaves grouping out of form fields", () => {
    expect(formatForInput(2499, 0)).toBe("2499");
    expect(formatForInput(180)).toBe("180,0");
    expect(formatForInput(null)).toBe("");
    expect(formatForInput(undefined)).toBe("");
  });

  it("renders a non-finite value as a dash rather than NaN", () => {
    expect(formatDecimal(Number.NaN)).toBe("—");
    expect(formatDecimal(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
