/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { FoodSearchResult } from "shared";
import { combineSearch, type FoodSearchState } from "../../src/lib/food.js";
import { SearchStatus } from "../../src/components/SearchStatus.js";

/**
 * Search says where it is (D165): "söker" while a part runs, local rows first
 * and remote rows appended, a timeout that keeps the local rows, and "inget
 * hittat" only after every source has answered.
 */

afterEach(cleanup);

const item = (id: string, name: string) =>
  ({ id, name, brand: null, kcalPer100: 100 }) as unknown as FoodSearchResult["items"][number];

const result = (items: FoodSearchResult["items"], extra: Partial<FoodSearchResult> = {}): FoodSearchResult => ({
  items,
  cacheOnly: false,
  notice: null,
  enough: false,
  timedOut: false,
  ...extra,
});

const none = { fetching: false, failed: false };

function state(input: Partial<Parameters<typeof combineSearch>[0]>): FoodSearchState {
  return combineSearch({
    query: "kvarg",
    enabled: true,
    local: { ...none },
    remote: { ...none, skipped: false },
    ...input,
  });
}

function statusText(value: FoodSearchState): string | null {
  render(<SearchStatus state={value} />);
  return screen.queryByTestId("search-status")?.textContent ?? null;
}

describe("combining the two parts of a search", () => {
  it("says söker, in Sten, while the local part runs", () => {
    const value = state({ local: { fetching: true, failed: false } });

    expect(value.searching).toBe("local");
    expect(value.nothingFound).toBe(false);
    expect(statusText(value)).toBe("Söker");
    expect(screen.getByTestId("search-status").className).toContain("text-uncertain");
  });

  it("shows local rows at once and keeps looking in the database", () => {
    const value = state({
      local: { data: result([item("a", "Kvarg")]), ...none },
      remote: { fetching: true, failed: false, skipped: false },
    });

    expect(value.items.map((row) => row.name)).toEqual(["Kvarg"]);
    expect(value.searching).toBe("remote");
    expect(statusText(value)).toBe("Söker vidare i livsmedelsdatabasen");
  });

  it("appends remote rows after the local ones, without repeating a row both returned", () => {
    const value = state({
      local: { data: result([item("a", "Kvarg"), item("b", "Kvarg vanilj")]), ...none },
      remote: {
        data: result([item("b", "Kvarg vanilj"), item("c", "Lindahls Kvarg")]),
        ...none,
        skipped: false,
      },
    });

    expect(value.items.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(value.searching).toBeNull();
    expect(statusText(value)).toBeNull();
  });

  it("keeps the local rows and says so when the database does not answer in time", () => {
    const value = state({
      local: { data: result([item("a", "Kvarg")]), ...none },
      remote: { data: result([], { timedOut: true, notice: "server text" }), ...none, skipped: false },
    });

    expect(value.items).toHaveLength(1);
    expect(value.timedOut).toBe(true);
    expect(value.nothingFound).toBe(false);
    expect(statusText(value)).toBe(
      "Livsmedelsdatabasen svarade inte i tid. Det som redan fanns sparat visas ovan.",
    );
  });

  it("treats the browser giving up as a timeout too, and never as nothing found", () => {
    const value = state({
      local: { data: result([]), ...none },
      remote: { fetching: false, failed: true, skipped: false },
    });

    expect(value.timedOut).toBe(true);
    expect(value.nothingFound).toBe(false);
    expect(statusText(value)).toMatch(/svarade inte i tid, och inget sparat matchade/);
  });

  it("does not say nothing found while the database is still being asked", () => {
    const value = state({
      local: { data: result([]), ...none },
      remote: { fetching: true, failed: false, skipped: false },
    });

    expect(value.nothingFound).toBe(false);
    expect(statusText(value)).toBe("Söker i livsmedelsdatabasen");
  });

  it("does not say nothing found when a source was unavailable", () => {
    const value = state({
      local: { data: result([]), ...none },
      remote: {
        data: result([], { notice: "Livsmedelsdatabasen är tillfälligt otillgänglig." }),
        ...none,
        skipped: false,
      },
    });

    expect(value.nothingFound).toBe(false);
    expect(statusText(value)).toBe("Livsmedelsdatabasen är tillfälligt otillgänglig.");
  });

  it("says nothing found once every source has answered empty", () => {
    const value = state({
      local: { data: result([]), ...none },
      remote: { data: result([]), ...none, skipped: false },
    });

    expect(value.nothingFound).toBe(true);
    expect(statusText(value)).toBe("Inget hittat för ”kvarg”.");
  });

  it("does not ask the database when the cache has already answered", () => {
    const value = state({
      local: { data: result([item("a", "Kvarg")], { enough: true }), ...none },
      remote: { fetching: false, failed: false, skipped: true },
    });

    expect(value.searching).toBeNull();
    expect(value.items).toHaveLength(1);
    expect(statusText(value)).toBeNull();
  });

  it("is idle, with nothing to say, before a search is submitted", () => {
    const value = combineSearch({
      query: "kvarg",
      enabled: false,
      local: { ...none },
      remote: { ...none, skipped: false },
    });

    expect(value).toMatchObject({ items: [], searching: null, nothingFound: false });
    expect(statusText(value)).toBeNull();
  });
});
