/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { formatKcal, type CorrelationPane } from "shared";
import { PaneChart } from "../../src/routes/Correlations.js";

/**
 * Samband's intake pane, one point per whole week (D166).
 *
 * The chart itself does not draw in jsdom, which has no layout for Recharts to
 * measure. What is tested here is everything around it: the "inte än" state in
 * weeks, the notes about lag and the expected line, and, by reading the source,
 * that the one line on this screen is the expected line and not a fit.
 */

afterEach(cleanup);

const weekly = (over: Partial<CorrelationPane>): CorrelationPane => ({
  pane: "intake_trend_change",
  pairs: [],
  sampleSize: 0,
  unpairedDays: 0,
  range: null,
  enough: false,
  unit: "week",
  needed: 4,
  lagDays: 9,
  reference: null,
  ...over,
});

const points = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    localDate: `2026-07-${String(6 + index * 7).padStart(2, "0")}`,
    x: 2000 + index * 100,
    y: -0.4 + index * 0.1,
  }));

describe("the weekly pane", () => {
  it("says not yet, in whole weeks, below four", () => {
    render(<PaneChart pane={weekly({ sampleSize: 2, pairs: points(2) })} minPairs={14} dailyLogDays={30} />);

    expect(screen.getByTestId("weeks-not-yet").textContent).toBe("Inte än. 2 av 4 hela veckor.");
    expect(screen.getByText("En vecka räknas när minst 6 av dess dagar har intag loggat.")).toBeTruthy();
    // Not the daily pane's "dagar av 14".
    expect(screen.queryByText(/av 14/)).toBeNull();
  });

  it("explains the lag and the expected line when maintenance is measured", () => {
    render(
      <PaneChart
        pane={weekly({
          sampleSize: 5,
          pairs: points(5),
          enough: true,
          range: { from: "2026-07-06", to: "2026-08-09" },
          reference: { maintenanceKcal: 2480, kcalPerKg: 7700 },
        })}
        minPairs={14}
        dailyLogDays={60}
      />,
    );

    const notes = screen.getByTestId("week-notes").textContent ?? "";
    expect(notes).toContain("ungefär 9 dagar efter vågen");
    // Through the app's own formatter, which groups with a non-breaking space.
    expect(notes).toContain(`uppmätta underhållsnivå, ${formatKcal(2480)} kcal`);
    expect(notes).toContain("närmast en ändring i intaget hamnar vid sidan av linjen");
    expect(screen.getByText("Antal veckor")).toBeTruthy();
  });

  it("says why there is no line when maintenance is not measured", () => {
    render(
      <PaneChart
        pane={weekly({ sampleSize: 5, pairs: points(5), enough: true })}
        minPairs={14}
        dailyLogDays={60}
      />,
    );

    expect(screen.getByTestId("week-notes").textContent).toContain("inte uträknad ur en formel");
  });
});

/**
 * D34, as amended by D166: the screen draws one line, the expected one, and no
 * fit. Read from the source, because a chart that does not render in jsdom
 * cannot be asked what it drew.
 */
describe("what Correlations.tsx is allowed to draw", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../../src/routes/Correlations.tsx"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, "");

  it("has no Line and no line on a Scatter", () => {
    expect(code).not.toMatch(/<Line\b/);
    expect(code).not.toMatch(/<Scatter[^>]*\bline\b/);
  });

  it("has exactly one ReferenceLine, and it is built from the reference, not the points", () => {
    expect(code.match(/<ReferenceLine\b/g)).toHaveLength(1);
    expect(code).toContain("expectedChangeKgPerWeek(x, reference.maintenanceKcal)");
  });
});
