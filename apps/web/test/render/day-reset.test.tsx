/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { addDays } from "shared";
import { LogDateProvider } from "../../src/lib/log-date.js";
import { DailyLog } from "../../src/routes/DailyLog.js";
import { stubFetch, type StatefulRoute } from "./harness.js";

/**
 * Changing the day must reset the form to that day's actual state.
 *
 * The bug was a correctness defect rather than a cosmetic one. The seeding
 * effect bailed out when the loaded day had no stored row, so browsing from a
 * filled day to an empty one left the filled day's answers sitting in the
 * inputs — with the save button directly beneath them. Pressing it would have
 * written Tuesday's sleep, mood and step count onto a Wednesday nobody had
 * logged, and nothing anywhere would have said so.
 *
 * The other half of the requirement is that typing survives a refetch, which is
 * why the guard is a version string rather than a dependency on the query
 * object: TanStack Query refetches on focus and hands back a new object every
 * time.
 */

const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "test@example.test",
  displayName: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  profile: {
    heightCm: 180,
    birthDate: null,
    sex: "unspecified",
    timezone: "Europe/Stockholm",
    locale: "sv-SE",
    activityFactor: 1.35,
    addExerciseToTarget: false,
    soberAssumeUnloggedDry: false,
    lastDrinkOn: null,
    macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
  },
};

function today(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

/** A day with everything filled in. */
const filledDay = (localDate: string) => ({
  localDate,
  daily: {
    id: "33333333-3333-3333-3333-333333333333",
    clientUuid: "33333333-3333-3333-3333-333333333333",
    localDate,
    loggedAt: "2026-09-01T20:00:00.000Z",
    sweat: 4,
    energy: 5,
    mood: 4,
    hunger: 2,
    sleepHours: 7.5,
    steps: 9123,
    alcoholUnits: 2,
    note: "En bra dag",
  },
  measurement: null,
  activities: [],
  weightKg: null,
  savingsRules: [],
});

/** A day nobody logged. Everything absent, nothing zero. */
const emptyDay = (localDate: string) => ({
  localDate,
  daily: null,
  measurement: null,
  activities: [],
  weightKg: null,
  savingsRules: [],
});

function mount(stateful: StatefulRoute[]) {
  stubFetch([{ match: "/api/me", body: ME }], [], stateful);
  window.localStorage.clear();

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 30_000, networkMode: "always" },
      mutations: { retry: false, networkMode: "always" },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/dag"]}>
        <LogDateProvider timezone="Europe/Stockholm">
          <DailyLog />
        </LogDateProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("changing the day on Dagen", () => {
  it("clears the form when the day it moves to is empty", async () => {
    const yesterday = addDays(today(), -1);

    // Today is filled in; yesterday was never logged.
    mount([
      {
        match: "/api/day",
        // The date comes off the request, exactly as the real endpoint reads it.
        get: (url) => (askedFor(url) === today() ? filledDay(today()) : emptyDay(askedFor(url))),
      },
    ]);

    const steps = () => screen.getByLabelText(/Steg/i) as HTMLInputElement;
    const note = () => screen.getByLabelText(/Anteckning/i) as HTMLInputElement;

    await waitFor(() => expect(steps().value).toBe("9123"));
    expect(note().value).toBe("En bra dag");

    // Back one day, to a day with nothing on it.
    expect(yesterday < today()).toBe(true);
    (await screen.findByTestId("date-back")).click();

    /**
     * Empty, not "9123". The failure this test exists for is that these keep
     * the previous day's answers with the save button underneath them.
     */
    await waitFor(() => expect(steps().value).toBe(""));
    expect(note().value).toBe("");

    // The ratings too, not only the text fields.
    expect(
      (screen.getByTestId("energy-5") as HTMLButtonElement).getAttribute("aria-pressed"),
    ).not.toBe("true");
  });

  it("fills the form again on the way back", async () => {
    mount([
      {
        match: "/api/day",
        get: (url) => (askedFor(url) === today() ? filledDay(today()) : emptyDay(askedFor(url))),
      },
    ]);

    const steps = () => screen.getByLabelText(/Steg/i) as HTMLInputElement;

    await waitFor(() => expect(steps().value).toBe("9123"));

    (await screen.findByTestId("date-back")).click();
    await waitFor(() => expect(steps().value).toBe(""));

    (await screen.findByTestId("date-forward")).click();
    await waitFor(() => expect(steps().value).toBe("9123"));
  });
});

/** The day a `/api/day` request is asking about. */
function askedFor(url: string): string {
  return new URLSearchParams(url.split("?")[1] ?? "").get("localDate") ?? today();
}
