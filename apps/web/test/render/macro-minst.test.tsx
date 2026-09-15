/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dayMacros, type InsightsResponse, type MacroLineDto } from "shared";
import { DayCard } from "../../src/components/DayCard.js";
import { DayMacroLine } from "../../src/components/DayMacroLine.js";

/**
 * Incomplete sums say "minst", at every span (D55, addendum 2026-09-15).
 *
 * Three states per macro and two spans on Översikt, and one span on Mat:
 *
 * - **complete**: the figure, plainly;
 * - **partial**: "minst" and the known sum, in Sten (`figure-partial`), with the
 *   share of the food that carries it on the line below;
 * - **absent**: nothing, and a reason, only when no logged food carries it.
 */

afterEach(cleanup);

const line = (over: Partial<MacroLineDto>): MacroLineDto => ({
  targetG: 120,
  overridden: false,
  derivedG: 120,
  todayG: null,
  todayCoverage: 0,
  todayComplete: false,
  weeklyMeanG: null,
  weeklyDays: 0,
  weeklyComplete: false,
  weeklyCoverage: 0,
  weeklyPartialDays: 0,
  weeklyDaysLogged: 6,
  ...over,
});

function insights(): InsightsResponse {
  return {
    todayIntakeKcal: 1400,
    targetIntakeKcal: 2000,
    todayRemainingKcal: 600,
    macros: {
      proteinBasis: "energy_percent",
      belowLowEnergyThreshold: false,
      // Complete at both spans.
      protein: line({
        todayG: 100,
        todayCoverage: 1,
        todayComplete: true,
        weeklyMeanG: 110,
        weeklyDays: 6,
        weeklyComplete: true,
        weeklyCoverage: 1,
      }),
      // Partial at both spans.
      carbs: line({
        targetG: 250,
        todayG: 80,
        todayCoverage: 0.43,
        todayComplete: false,
        weeklyMeanG: 150,
        weeklyDays: 6,
        weeklyComplete: false,
        weeklyCoverage: 0.78,
        weeklyPartialDays: 2,
      }),
      // Complete today, a floor over the week.
      fat: line({
        targetG: 70,
        todayG: 50,
        todayCoverage: 0.95,
        todayComplete: true,
        weeklyMeanG: 60,
        weeklyDays: 6,
        weeklyComplete: false,
        weeklyCoverage: 0.88,
        weeklyPartialDays: 1,
      }),
      // No logged food carries it, at either span.
      fiber: line({ targetG: 30 }),
    },
  } as unknown as InsightsResponse;
}

const figure = (key: string) => screen.getByTestId(`macro-${key}-figure`);

describe("the day card on Översikt", () => {
  it("over the week: plain when complete, minst in Sten when any day was partial, a reason when absent", () => {
    render(<DayCard insights={insights()} onLogFood={() => {}} />);

    expect(figure("protein").textContent).toBe("110 av 120 g");
    expect(figure("protein").className).not.toContain("figure-partial");

    expect(figure("carbs").textContent).toBe("minst 150 av 250 g");
    expect(figure("carbs").className).toContain("figure-partial");
    expect(screen.getByText("snitt över 6 dagar, 78 % av maten har uppgifter")).toBeTruthy();

    expect(figure("fat").textContent).toBe("minst 60 av 70 g");
    expect(figure("fat").className).toContain("figure-partial");

    expect(figure("fiber").textContent).toBe("Inte än");
    expect(screen.getByText("Ingen mat du loggat den här veckan har uppgift om fiber.")).toBeTruthy();
  });

  it("today: the same three states against the day's own coverage", () => {
    render(<DayCard insights={insights()} onLogFood={() => {}} />);
    fireEvent.click(screen.getByTestId("macro-view-today"));

    expect(figure("protein").textContent).toBe("100 av 120 g");
    expect(figure("carbs").textContent).toBe("minst 80 av 250 g");
    expect(figure("carbs").className).toContain("figure-partial");
    expect(screen.getByText("43 % av dagens mat har uppgifter")).toBeTruthy();
    // Complete today, although the week under it is a floor.
    expect(figure("fat").textContent).toBe("50 av 70 g");
    expect(figure("fat").className).not.toContain("figure-partial");

    expect(figure("fiber").textContent).toBe("Inte än");
    expect(screen.getByText("Ingen mat du loggat i dag har uppgift om fiber.")).toBeTruthy();
  });

  it("says fewer than three logged days rather than blaming the food", () => {
    const data = insights();
    data.macros!.fiber = line({ targetG: 30, weeklyDaysLogged: 2 });
    render(<DayCard insights={data} onLogFood={() => {}} />);

    expect(screen.getByText("2 av 3 dagar loggade den här veckan.")).toBeTruthy();
  });
});

describe("the day's macros on Mat", () => {
  const entry = (kcal: number, macros: Partial<Record<"proteinG" | "carbsG" | "fatG" | "fiberG", number>>) => ({
    kcal,
    proteinG: null,
    carbsG: null,
    fatG: null,
    fiberG: null,
    ...macros,
  });

  it("states a complete day plainly and leaves out what no food carries", () => {
    const day = dayMacros([entry(600, { proteinG: 40, carbsG: 50, fatG: 20 })]);
    render(<DayMacroLine day={day} dayWord="i dag" />);

    expect(screen.getByTestId("day-macros").textContent).toBe("Protein 40 g, Kolhydrat 50 g, Fett 20 g");
    expect(screen.queryByTestId("day-macro-fiber")).toBeNull();
    expect(screen.queryByTestId("day-macros-coverage")).toBeNull();
  });

  it("says minst in Sten for a partial day, with the share on the line below", () => {
    // The unlabelled dinner: its energy counts, its macros are unknown.
    const day = dayMacros([entry(600, { proteinG: 40, carbsG: 50, fatG: 20, fiberG: 5 }), entry(800, {})]);
    render(<DayMacroLine day={day} dayWord="i dag" />);

    expect(screen.getByTestId("day-macro-protein").textContent).toBe("Protein minst 40 g");
    expect(screen.getByTestId("day-macro-protein").className).toBe("figure-partial");
    expect(screen.getByTestId("day-macros-coverage").textContent).toBe("43 % av maten i dag har uppgifter");
  });

  it("names each share when the partial macros differ", () => {
    const day = dayMacros([entry(500, { proteinG: 40, fiberG: 3 }), entry(500, { proteinG: 20 })]);
    render(<DayMacroLine day={day} dayWord="den dagen" />);

    expect(screen.getByTestId("day-macro-protein").className).not.toBe("figure-partial");
    expect(screen.getByTestId("day-macros-coverage").textContent).toBe(
      "fiber 50 % av maten den dagen har uppgifter",
    );
  });

  it("draws nothing for a day on which no food carries any macro", () => {
    const { container } = render(<DayMacroLine day={dayMacros([entry(700, {})])} dayWord="i dag" />);
    expect(container.textContent).toBe("");
  });
});
