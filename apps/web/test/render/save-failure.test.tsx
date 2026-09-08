/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { FoodLog } from "../../src/routes/FoodLog.js";
import { SaveStalled, withTimeout } from "../../src/lib/queue/enqueue.js";

/**
 * What a save does when it does not work.
 *
 * Written after a report that logging food from the recent list "does not
 * work" and that scanning gets "stuck on saving" on a phone, while the same
 * actions work on a desktop browser. The stall itself could not be reproduced
 * off the device, but two defects in the way a save *fails* were plain in the
 * code and are exactly what that report looks like from outside:
 *
 *  - **one shared mutation disabled every row.** `useSaveFoodEntry` is one
 *    instance for the whole recent list, and every row was disabled on its
 *    `isPending`. Tapping one row disabled all of them, and a save that never
 *    settled left the entire list dead with no way back;
 *  - **a rejected save said nothing.** The handler awaited without catching, so
 *    a failure became an unhandled rejection: the tap did nothing, visibly and
 *    permanently.
 *
 * Note that this file deliberately does **not** import `fake-indexeddb`. With
 * no IndexedDB the queue is unavailable and the write goes straight to the
 * network, which is both a real path (private windows, storage the browser
 * refuses) and the one where the app is exposed to a slow or failing request.
 */

afterEach(cleanup);

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

const ENTRIES = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    localDate: "2026-09-03",
    mealSlot: "snack",
    foodItemId: "22222222-2222-4222-8222-222222222222",
    name: "Havregryn",
    grams: 100,
    kcal: 357,
    macros: null,
    confidence: 1,
    confirmed: true,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    localDate: "2026-09-03",
    mealSlot: "snack",
    foodItemId: "44444444-4444-4444-8444-444444444444",
    name: "Filmjölk",
    grams: 250,
    kcal: 140,
    macros: null,
    confidence: 1,
    confirmed: true,
  },
];

/**
 * The write, once the screen is up.
 *
 * The reads go through the shared harness, which is what every other render
 * test uses and is known to get a signed-in screen on the page. Only the POST
 * is taken over here, and only after the rows have rendered, so the test
 * controls the one request it is about and nothing else.
 */
function takeOverWrites(onWrite: () => Promise<Response>) {
  const reads = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") return onWrite();
    return reads(input, init);
  }) as typeof fetch;
}

const RESPONSES = [
  { match: "/api/me", body: ME },
  { match: "/api/food-entry/recent", body: { entries: ENTRIES } },
  { match: "/api/meal-templates", body: { templates: [] } },
];

describe("a save that is taking its time", () => {
  it("disables only the row that was tapped", async () => {
    renderRoute(<FoodLog />, { responses: RESPONSES });

    const rows = await screen.findAllByTestId("log-again");

    let release: (() => void) | undefined;
    takeOverWrites(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve({
              ok: true,
              status: 200,
              headers: new Headers({ "content-type": "application/json" }),
              json: async () => ({}),
              text: async () => "{}",
            } as Response);
        }),
    );

    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]!);

    await waitFor(() => expect((rows[0] as HTMLButtonElement).disabled).toBe(true));
    // The defect: this used to be disabled too, and stayed that way forever if
    // the first save never came back.
    expect((rows[1] as HTMLButtonElement).disabled).toBe(false);

    release?.();
  });
});

describe("a save the server refuses", () => {
  it("says so instead of doing nothing", async () => {
    renderRoute(<FoodLog />, { responses: RESPONSES });

    const rows = await screen.findAllByTestId("log-again");

    takeOverWrites(async () => {
      const body = { error: "no_energy", message: "Raden saknar energivärde." };
      return {
        ok: false,
        status: 422,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    });

    fireEvent.click(rows[0]!);

    // The server's own Swedish message, shown verbatim rather than replaced by
    // a generic one that knows less than the server did.
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("energivärde");
    });

    // And the row is usable again, rather than stuck.
    await waitFor(() => expect((rows[0] as HTMLButtonElement).disabled).toBe(false));
  });
});

/**
 * The mechanism that turns "never answers" into "did not work".
 *
 * Unit-tested rather than driven through the UI, because the condition it
 * exists for is a step that never settles, and a test that waits for one of
 * those to not happen is a test that takes as long as its own timeout.
 */
describe("bounding a step of the save", () => {
  it("gives up and names the step", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const bounded = withTimeout(never, 5000, "queue");
    const assertion = expect(bounded).rejects.toBeInstanceOf(SaveStalled);
    await vi.advanceTimersByTimeAsync(5001);
    await assertion;
    vi.useRealTimers();
  });

  it("passes a value straight through when the step answers", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "send")).resolves.toBe("ok");
  });

  it("does not leave a timer running behind a step that answered", async () => {
    vi.useFakeTimers();
    const cleared = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve(1), 5000, "queue");
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
    vi.useRealTimers();
  });
});
