import { describe, expect, it } from "vitest";
import { isWeekend, localMinuteOfDay, toLocalDate } from "./local-date.js";

/**
 * The day boundary, which both apps now share (D136).
 *
 * These run under `TZ=UTC` in CI and at UTC+2 on the workstation, so every
 * assertion supplies its own instant and its own zone. Nothing here reads the
 * machine clock, which is the mistake three render tests had to be fixed for.
 */

describe("the local date", () => {
  it("is the calendar date where the person is, not where the server is", () => {
    // 22:30 UTC on the 11th is already the 12th in Tokyo.
    const instant = new Date("2026-09-11T22:30:00.000Z");

    expect(toLocalDate(instant, "Europe/Stockholm")).toBe("2026-09-12");
    expect(toLocalDate(instant, "Asia/Tokyo")).toBe("2026-09-12");
    expect(toLocalDate(instant, "America/Los_Angeles")).toBe("2026-09-11");
  });

  /**
   * The server must not silently substitute its own zone. The client wraps this
   * and falls back, because an unknown zone must not stop somebody logging; the
   * scheduler skips the profile instead.
   */
  it("throws on a zone it does not know", () => {
    expect(() => toLocalDate(new Date(), "Nowhere/Invalid")).toThrow();
  });

  it("counts minutes past local midnight", () => {
    const instant = new Date("2026-09-11T05:00:00.000Z");

    expect(localMinuteOfDay(instant, "Europe/Stockholm")).toBe(7 * 60);
    expect(localMinuteOfDay(instant, "Asia/Tokyo")).toBe(14 * 60);
  });

  it("handles midnight and the minute before it", () => {
    expect(localMinuteOfDay(new Date("2026-09-11T22:00:00.000Z"), "Europe/Stockholm")).toBe(0);
    expect(localMinuteOfDay(new Date("2026-09-11T21:59:00.000Z"), "Europe/Stockholm")).toBe(23 * 60 + 59);
  });
});

describe("the weekend", () => {
  it("is Saturday and Sunday", () => {
    expect(isWeekend("2026-09-12")).toBe(true); // Saturday
    expect(isWeekend("2026-09-13")).toBe(true); // Sunday
  });

  it("is not any other day", () => {
    for (const weekday of [
      "2026-09-07", // Monday
      "2026-09-08",
      "2026-09-09",
      "2026-09-10",
      "2026-09-11", // Friday
    ]) {
      expect(isWeekend(weekday), `${weekday} should be a weekday`).toBe(false);
    }
  });

  /**
   * The case the whole arrangement exists for: Friday evening on the server is
   * already Saturday for somebody far enough east, and they get the weekend
   * time rather than Friday's.
   */
  it("follows the person, not the server", () => {
    const fridayEvening = new Date("2026-09-11T23:30:00.000Z"); // Friday 23:30 UTC

    expect(toLocalDate(fridayEvening, "Europe/London")).toBe("2026-09-12");
    expect(isWeekend(toLocalDate(fridayEvening, "Europe/London"))).toBe(true);

    // And still Friday for somebody west of it.
    expect(toLocalDate(fridayEvening, "America/Los_Angeles")).toBe("2026-09-11");
    expect(isWeekend(toLocalDate(fridayEvening, "America/Los_Angeles"))).toBe(false);
  });
});
