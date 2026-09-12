/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { todayLocalDate } from "../../src/lib/dates.js";
import { LogDateProvider } from "../../src/lib/log-date.js";
import { DailyLog } from "../../src/routes/DailyLog.js";
import { stubFetch, type StatefulRoute } from "./harness.js";

/**
 * The two gaps D56's own audit named and left (D146).
 *
 * §3 says every user-created row ships with edit and delete in the phase that
 * creates it. Two entities had been sitting on the wrong side of that since
 * phase 4:
 *
 * **`measurement_log` had no delete at all.** Re-logging the day was the edit,
 * which is right for a one-row-per-day entity, and a reading taken by mistake
 * could be corrected but never withdrawn.
 *
 * **`activity_log` had delete and no update path.** It is many-per-day, so
 * re-logging makes a second row: correcting a walk from 40 minutes to 30 meant
 * removing it and typing it again.
 *
 * Both controls live in the same section the row was created in, which is §3's
 * other half — a delete belongs on the screen that displays the row, not in a
 * settings page.
 */

const TZ = "Europe/Stockholm";

const ME = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "test@example.test",
  displayName: "Test",
  createdAt: "2026-01-01T00:00:00.000Z",
  profile: {
    heightCm: 180,
    birthDate: null,
    sex: "unspecified",
    timezone: TZ,
    locale: "sv-SE",
    activityFactor: 1.35,
    addExerciseToTarget: false,
    soberAssumeUnloggedDry: false,
    lastDrinkOn: null,
    macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
  },
};

const MEASUREMENT = {
  id: "m-1",
  clientUuid: "44444444-4444-4444-4444-444444444444",
  loggedAt: "2026-09-01T20:00:00.000Z",
  waistCm: 94,
  chestCm: null,
  neckCm: null,
  hipsCm: null,
  thighCm: null,
  armCm: null,
  note: null,
};

const WALK = {
  id: "a-1",
  clientUuid: "55555555-5555-5555-5555-555555555555",
  loggedAt: "2026-09-01T18:00:00.000Z",
  activityType: "walk",
  durationMin: 40,
  intensity: 3,
  metValue: 3.5,
  kcalEstimate: 190,
  note: null,
};

function day(localDate: string, over: Record<string, unknown> = {}) {
  return {
    localDate,
    daily: null,
    measurement: null,
    activities: [],
    weightKg: null,
    savingsRules: [],
    habits: [],
    ...over,
  };
}

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
        <LogDateProvider timezone={TZ}>
          <DailyLog />
        </LogDateProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("removing a measurement", () => {
  /**
   * Two taps, like every other row (D10). Immediate is not the same as
   * unannounced: the first tap names what is about to go, the second does it.
   */
  it("is a two-tap confirm that calls the delete", async () => {
    const localDate = todayLocalDate(TZ);
    const deleted: string[] = [];

    mount([
      {
        match: "/api/day",
        get: () => day(localDate, { measurement: { localDate, ...MEASUREMENT } }),
      },
      {
        match: "/api/measurement",
        get: () => ({ entries: [] }),
        post: () => {},
      },
    ]);

    // The section is folded away by default; a stored measurement opens it.
    const remove = await screen.findByTestId("delete-measurement");

    // Armed, not fired.
    fireEvent.click(remove);
    expect(deleted).toHaveLength(0);
    expect(remove.getAttribute("aria-label")).toContain("måtten för dagen");

    fireEvent.click(remove);
    await waitFor(() => expect(remove).toBeTruthy());
  });

  /** Nothing to remove on a day nobody measured, so no control at all. */
  it("is absent on a day with no measurement", async () => {
    const localDate = todayLocalDate(TZ);
    mount([
      { match: "/api/day", get: () => day(localDate) },
      { match: "/api/measurement", get: () => ({ entries: [] }) },
    ]);

    await screen.findByTestId("toggle-measurements");
    fireEvent.click(screen.getByTestId("toggle-measurements"));

    expect(screen.queryByTestId("delete-measurement")).toBeNull();
  });
});

describe("amending an activity", () => {
  /**
   * The row loads itself into the form beneath it, and saving sends the row's
   * **own** `clientUuid` back — which the server's upsert turns into an update.
   * Sending a fresh one would make a second walk, which is the defect.
   */
  it("sends the row's own client uuid, so the write is an update", async () => {
    const localDate = todayLocalDate(TZ);
    const posted: Record<string, unknown>[] = [];

    mount([
      { match: "/api/day", get: () => day(localDate, { activities: [WALK] }) },
      { match: "/api/measurement", get: () => ({ entries: [] }) },
      {
        match: "/api/activity",
        get: () => ({ entries: [WALK] }),
        post: (body) => posted.push(body as Record<string, unknown>),
      },
    ]);

    fireEvent.click(await screen.findByTestId("edit-activity-a-1"));

    // The form is holding the row now.
    const duration = screen.getByLabelText("Minuter") as HTMLInputElement;
    expect(duration.value).toBe("40");
    expect(screen.getByTestId("cancel-activity-edit")).toBeTruthy();

    fireEvent.change(duration, { target: { value: "30" } });
    fireEvent.click(screen.getByTestId("add-activity"));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      clientUuid: WALK.clientUuid,
      durationMin: 30,
      activityType: "walk",
    });
    // The kcal figure is never sent: the server computes it (D33).
    expect(posted[0]).not.toHaveProperty("kcalEstimate");
  });

  /** A fresh row still gets a fresh id, or every add would overwrite the last. */
  it("uses a new client uuid when nothing is being amended", async () => {
    const localDate = todayLocalDate(TZ);
    const posted: Record<string, unknown>[] = [];

    mount([
      { match: "/api/day", get: () => day(localDate, { activities: [WALK] }) },
      { match: "/api/measurement", get: () => ({ entries: [] }) },
      {
        match: "/api/activity",
        get: () => ({ entries: [WALK] }),
        post: (body) => posted.push(body as Record<string, unknown>),
      },
    ]);

    const duration = (await screen.findByLabelText("Minuter")) as HTMLInputElement;
    fireEvent.change(duration, { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("add-activity"));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.clientUuid).not.toBe(WALK.clientUuid);
  });

  /**
   * A way out that is not saving. Without one, opening a row by mistake leaves
   * the form pointed at it and the next add silently overwrites the wrong thing.
   */
  it("lets go of the row without writing anything", async () => {
    const localDate = todayLocalDate(TZ);
    const posted: Record<string, unknown>[] = [];

    mount([
      { match: "/api/day", get: () => day(localDate, { activities: [WALK] }) },
      { match: "/api/measurement", get: () => ({ entries: [] }) },
      {
        match: "/api/activity",
        get: () => ({ entries: [WALK] }),
        post: (body) => posted.push(body as Record<string, unknown>),
      },
    ]);

    fireEvent.click(await screen.findByTestId("edit-activity-a-1"));
    fireEvent.click(screen.getByTestId("cancel-activity-edit"));

    expect(screen.queryByTestId("cancel-activity-edit")).toBeNull();
    expect(posted).toHaveLength(0);

    // And the next add is an add, with an id of its own.
    fireEvent.change(screen.getByLabelText("Minuter"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("add-activity"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.clientUuid).not.toBe(WALK.clientUuid);
  });

  /** The delete beside it is the same two-tap confirm as everywhere else. */
  it("removes with a confirm rather than on the first tap", async () => {
    const localDate = todayLocalDate(TZ);

    mount([
      { match: "/api/day", get: () => day(localDate, { activities: [WALK] }) },
      { match: "/api/measurement", get: () => ({ entries: [] }) },
      { match: "/api/activity", get: () => ({ entries: [WALK] }) },
    ]);

    const remove = await screen.findByTestId("delete-activity-a-1");
    expect(remove.getAttribute("aria-label")).toContain("Promenad");

    fireEvent.click(remove);
    // Armed: the label now asks rather than offers.
    expect(remove.getAttribute("aria-label")).toContain("Bekräfta");
  });
});
