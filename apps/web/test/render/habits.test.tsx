/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { HabitDay } from "shared";
import { renderRoute } from "./harness.js";
import { HabitChecklist } from "../../src/components/HabitChecklist.js";
import { HabitEditor } from "../../src/components/HabitEditor.js";

/**
 * The checklist, through the interface (D137).
 *
 * One tap ticks and one tap unticks, and what these pin down is that the second
 * tap sends `checked: false` rather than nothing: a day answered with no tick
 * is a different fact from a day nobody answered, and the streak reads them
 * differently. A component that simply stopped sending on the second tap would
 * look identical on screen and be wrong in the database.
 *
 * jsdom has no IndexedDB, so the queue falls through to sending directly (D118)
 * and the write arrives at the stub as an ordinary POST. That is the same path
 * a phone with a refusing store takes, which makes it worth exercising.
 */

function habit(overrides: Partial<HabitDay> = {}): HabitDay {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Vitaminer",
    icon: "tablett",
    sortOrder: 0,
    remind: false,
    remindMinute: 480,
    remindWeekend: false,
    remindWeekendMinute: 480,
    createdAt: "2026-09-01T00:00:00.000Z",
    checked: false,
    answered: false,
    streak: {
      days: 0,
      graceUsed: 0,
      startedOn: null,
      countingFrom: null,
      basis: "no_data",
      checkedToday: false,
    },
    ...overrides,
  };
}

function mount(habits: HabitDay[], localDate = "2026-09-11") {
  const posts: Record<string, unknown>[] = [];

  renderRoute(<HabitChecklist habits={habits} localDate={localDate} />, {
    responses: [
      { match: "/api/me", body: { profile: { timezone: "Europe/Stockholm" } } },
      { match: "/api/habits", body: { habits } },
    ],
    stateful: [
      {
        match: "/api/habit-check",
        get: () => ({}),
        post: (body) => posts.push(body as Record<string, unknown>),
        wrote: { id: "x", habitId: habits[0]?.id ?? "", localDate, checked: true, streak: {} },
      },
    ],
  });

  return { posts };
}

describe("ticking a habit", () => {
  afterEach(cleanup);

  it("sends the tick for the day being shown", async () => {
    const row = habit();
    const { posts } = mount([row], "2026-09-08");

    fireEvent.click(await screen.findByTestId(`habit-${row.id}`));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      habitId: row.id,
      // The day on screen, not today: backfilling is ordinary (D62).
      localDate: "2026-09-08",
      checked: true,
    });
  });

  /**
   * The second tap is a write, not a silence. This is the assertion that stops
   * "unticked" and "unanswered" from quietly becoming the same thing.
   */
  it("sends checked false when a ticked habit is tapped again", async () => {
    const row = habit({ checked: true, answered: true });
    const { posts } = mount([row]);

    fireEvent.click(await screen.findByTestId(`habit-${row.id}`));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ checked: false });
  });

  it("says how many days in a row, and only when there are any", async () => {
    const running = habit({
      id: "22222222-2222-2222-2222-222222222222",
      streak: {
        days: 4,
        graceUsed: 0,
        startedOn: "2026-09-08",
        countingFrom: "2026-09-08",
        basis: "from_first",
        checkedToday: true,
      },
    });

    mount([habit(), running]);

    expect(await screen.findByText("4 dagar i rad")).toBeTruthy();
    // The habit with no chain says nothing rather than saying zero.
    expect(screen.queryByText("0 dagar i rad")).toBeNull();
  });

  /** Which rule produced those numbers, said once, as the sober counter does. */
  it("says how the days are counted", async () => {
    mount([habit()]);
    expect(await screen.findByText(/okänd, inte missad/)).toBeTruthy();
  });
});

describe("an empty checklist", () => {
  afterEach(cleanup);

  it("says what it is for and offers three to start from", async () => {
    const posts: Record<string, unknown>[] = [];

    renderRoute(<HabitChecklist habits={[]} localDate="2026-09-11" />, {
      responses: [
        { match: "/api/me", body: { profile: { timezone: "Europe/Stockholm" } } },
      ],
      stateful: [
        {
          match: "/api/habits",
          get: () => ({ habits: [] }),
          post: (body) => posts.push(body as Record<string, unknown>),
          wrote: { id: "new", name: "Vitaminer", icon: "tablett", sortOrder: 0 },
        },
      ],
    });

    expect(await screen.findByTestId("habit-example-droppe")).toBeTruthy();
    expect(screen.getByTestId("habit-example-tablett")).toBeTruthy();
    expect(screen.getByTestId("habit-example-stretch")).toBeTruthy();

    // A suggestion, added with one tap. Nothing was seeded before that tap.
    fireEvent.click(screen.getByTestId("habit-example-tablett"));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ name: "Vitaminer", icon: "tablett" });
  });
});

describe("removing a habit", () => {
  afterEach(cleanup);

  const row = {
    id: "33333333-3333-3333-3333-333333333333",
    name: "Vitaminer",
    icon: null,
    sortOrder: 0,
    remind: false,
    remindMinute: 480,
    remindWeekend: false,
    remindWeekendMinute: 480,
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  function mountEditor() {
    const deletes: string[] = [];

    renderRoute(<HabitEditor open onClose={() => {}} />, {
      responses: [
        { match: "/api/me", body: { profile: { timezone: "Europe/Stockholm" } } },
        { match: "/api/habits", body: { habits: [row] } },
      ],
    });

    // The harness stub answers every DELETE the same way; what matters is the
    // URL, so it is read off the request rather than from a stateful route.
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if ((init?.method ?? "GET").toUpperCase() === "DELETE") deletes.push(url);
      return original(input as RequestInfo, init);
    }) as typeof fetch;

    return { deletes };
  }

  /**
   * Both outcomes are named before either happens. The difference is not
   * recoverable, so it is stated rather than defaulted.
   */
  it("says what will happen to the history, and offers both", async () => {
    const { deletes } = mountEditor();

    fireEvent.click(await screen.findByTestId(`habit-open-${row.id}`));
    fireEvent.click(await screen.findByTestId(`habit-remove-${row.id}`));

    expect(await screen.findByTestId("habit-remove-confirm")).toBeTruthy();
    expect(screen.getByText(/finns kvar/)).toBeTruthy();
    expect(screen.getByText(/går inte att ångra/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("habit-remove-all"));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toContain("history=remove");
  });

  it("keeps the history when that is the one chosen", async () => {
    const { deletes } = mountEditor();

    fireEvent.click(await screen.findByTestId(`habit-open-${row.id}`));
    fireEvent.click(await screen.findByTestId(`habit-remove-${row.id}`));
    // The sheet's own confirm is the gentler of the two.
    fireEvent.click(await screen.findByTestId("habit-remove-confirm-confirm"));

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0]).toContain("history=keep");
  });
});
