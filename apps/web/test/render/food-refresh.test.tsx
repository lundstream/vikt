/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sumOrNull } from "shared";
import { db } from "../../src/lib/queue/db.js";
import { useQueueSync } from "../../src/lib/queue/useQueue.js";
import { useFoodEntries, useSaveFoodEntry } from "../../src/lib/food.js";
import { stubFetch, type StatefulRoute } from "./harness.js";

/**
 * The day's calorie total has to move when a food is logged, without a reload.
 *
 * The bug: `enqueueAndSync` resolves as soon as the entry is stored **locally**,
 * which is the whole point of the queue (D39-D42) — a meal logged in a shop
 * basement is logged, and the screen must not wait on a network that may not be
 * there. What went wrong is that the mutation invalidated the cache at that
 * moment, so the refetch raced the POST and normally won. The list came back
 * without the entry that had just been added and stayed exactly one short until
 * a manual refresh, and the day's total — the number every other figure in the
 * app is derived from — was wrong on screen while the user looked at it.
 *
 * `useQueueSync` now refetches when the queue reports the write **sent**. This
 * mounts that hook next to the same query the food screen uses and the same
 * total it computes, because the wiring between the two is the thing that broke;
 * `queue.test.ts` pins the notification itself.
 */

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

const entry = (id: string, kcal: number) => ({
  id,
  clientUuid: id,
  localDate: today(),
  loggedAt: "2026-09-02T08:00:00.000Z",
  mealSlot: "breakfast",
  foodItemId: null,
  name: "Havregryn",
  brand: null,
  grams: 100,
  kcal,
  proteinG: null,
  carbsG: null,
  fatG: null,
  fiberG: null,
  confidence: 1,
  confirmed: true,
});

/**
 * The day's total, computed exactly as `FoodLog` computes it, beside the hook
 * that drives the refetch. Rendering the number is what makes "without a
 * reload" a claim about the screen rather than about the cache.
 */
function DayTotal({ onLogged }: { onLogged: (log: () => void) => void }) {
  useQueueSync();
  const entries = useFoodEntries(today(), today());
  const save = useSaveFoodEntry("Europe/Stockholm");

  onLogged(() => {
    void save.mutateAsync({
      clientUuid: "22222222-2222-2222-2222-222222222222",
      localDate: today(),
      freetext: "Havregryn",
      grams: 100,
      kcal: 215,
      mealSlot: "breakfast",
      confidence: 1,
      confirmed: true,
    });
  });

  const total =
    entries.data === undefined
      ? undefined
      : sumOrNull(entries.data.map((row) => row.kcal));

  return <p data-testid="total">{total === undefined ? "…" : String(total)}</p>;
}

function mount(stateful: StatefulRoute[]) {
  stubFetch([], [], stateful);

  const client = new QueryClient({
    defaultOptions: {
      /**
       * `staleTime` matches the real hooks. Setting it to 0 here hid the bug:
       * React Query then refetches on its own often enough to recover, so the
       * test passed against the broken code. The production value is what makes
       * a missed invalidation permanent until a reload, which is exactly the
       * reported symptom.
       */
      queries: { retry: false, staleTime: 30_000, networkMode: "always" },
      mutations: { retry: false, networkMode: "always" },
    },
  });

  let log = () => {};
  const result = render(
    <QueryClientProvider client={client}>
      <DayTotal
        onLogged={(fn) => {
          log = fn;
        }}
      />
    </QueryClientProvider>,
  );

  return { ...result, log: () => log() };
}

beforeEach(async () => {
  await db.mutations.clear();
  await db.conflicts.clear();
});

afterEach(cleanup);

describe("the day's total, after logging", () => {
  it("moves once the server has the entry, with no reload", async () => {
    /**
     * The server's view. `post` appends, exactly as the real endpoint does, so
     * a refetch *before* the POST lands returns the old list and one after it
     * returns the new one. That difference is the whole test: against the old
     * code the total settles on 215 and stays there.
     */
    const entries = [entry("11111111-1111-1111-1111-111111111111", 215)];

    const { getByTestId, log } = mount([
      {
        match: "/api/food-entry",
        get: () => ({ entries }),
        post: (body) => {
          const posted = body as { clientUuid: string };
          entries.push(entry(posted.clientUuid, 215));
        },
        /**
         * A real network takes time, and that is what makes the bug a bug: the
         * refetch fired on enqueue completes while the POST is still in flight.
         * With an instant stub this test passes against the broken code.
         */
        delayMs: 60,
      },
    ]);

    await waitFor(() => expect(getByTestId("total").textContent).toBe("215"));

    log();

    await waitFor(() => expect(getByTestId("total").textContent).toBe("430"), {
      timeout: 5000,
    });

    // The entry reached the server too, not only the number on screen.
    expect(entries).toHaveLength(2);
  });
});
