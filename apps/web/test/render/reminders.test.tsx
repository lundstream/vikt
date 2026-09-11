/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Reminders } from "../../src/components/Reminders.js";

/**
 * Weekday times and weekend times, through the interface (D136, amended).
 *
 * The rule these tests exist for is that the two pairs are **independent**: the
 * weekend switch must not be wired to the weekday field, and a time typed into
 * one column must not be saved as the other. That is the mistake the shape
 * invites, and it is invisible in a screenshot, because a wrong field with the
 * right value still looks right.
 *
 * jsdom has no `Notification` and no service worker, so the section renders its
 * "this browser cannot" state. The times are shown regardless, which is
 * deliberate: somebody setting this up on a laptop and receiving it on a phone
 * is the normal case.
 */

function me(profile: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    email: "someone@example.test",
    displayName: "Someone",
    createdAt: "2026-01-01T00:00:00.000Z",
    isAdmin: false,
    profile: {
      heightCm: 180,
      birthDate: null,
      sex: "unspecified",
      timezone: "Europe/Stockholm",
      locale: "sv-SE",
      activityFactor: 1.35,
      addExerciseToTarget: false,
      soberAssumeUnloggedDry: false,
      newsMail: true,
      theme: "system",
      lastDrinkOn: null,
      macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
      ...profile,
    },
  };
}

/** The section with push configured, and a record of every PATCH it sends. */
function mount(profile: Record<string, unknown>) {
  const patches: Record<string, unknown>[] = [];

  renderRoute(<Reminders />, {
    responses: [
      { match: "/api/push/key", body: { publicKey: "test-key" } },
      { match: "/api/push/subscriptions", body: { subscriptions: [] } },
      { match: "/api/me", body: me(profile) },
    ],
    stateful: [
      {
        match: "/api/me/profile",
        get: () => ({}),
        post: (body) => patches.push(body as Record<string, unknown>),
      },
    ],
  });

  return { patches };
}

const SPLIT = {
  remindWeigh: true,
  remindWeighMinute: 420, // 07:00 on a weekday
  remindWeighWeekend: true,
  remindWeighWeekendMinute: 540, // 09:00 at the weekend
  remindDay: true,
  remindDayMinute: 1320,
  remindDayWeekend: false,
  remindDayWeekendMinute: 1320,
};

describe("the two times", () => {
  afterEach(cleanup);

  it("shows a weekday time and a weekend time for each reminder", async () => {
    mount(SPLIT);

    const weighWeekday = await screen.findByTestId("remind-weigh-time");
    const weighWeekend = await screen.findByTestId("remind-weigh-weekend-time");

    expect((weighWeekday as HTMLInputElement).value).toBe("07:00");
    expect((weighWeekend as HTMLInputElement).value).toBe("09:00");

    // Four switches, one per reminder per day group, in the state the profile
    // says: the evening reminder is on during the week and off at the weekend.
    expect((screen.getByTestId("remind-weigh") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("remind-weigh-weekend") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("remind-day") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("remind-day-weekend") as HTMLInputElement).checked).toBe(false);
  });

  /** The day labels, so the two columns are not two unexplained boxes. */
  it("says which days each column is", async () => {
    mount(SPLIT);

    await screen.findByTestId("remind-weigh-time");
    expect(screen.getAllByText("Vardagar")).toHaveLength(2);
    expect(screen.getAllByText("Helg")).toHaveLength(2);
  });

  it("saves the weekend switch as the weekend switch", async () => {
    const { patches } = mount(SPLIT);

    fireEvent.click(await screen.findByTestId("remind-day-weekend"));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ remindDayWeekend: true });
  });

  it("saves the weekday switch as the weekday switch", async () => {
    const { patches } = mount(SPLIT);

    fireEvent.click(await screen.findByTestId("remind-weigh"));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ remindWeigh: false });
  });

  /**
   * The one that matters most: a time typed into the weekend column is saved
   * as the weekend minute, and the weekday one is left alone.
   */
  it("saves a weekend time without touching the weekday time", async () => {
    const { patches } = mount(SPLIT);

    const field = await screen.findByTestId("remind-weigh-weekend-time");
    fireEvent.change(field, { target: { value: "10:30" } });
    fireEvent.blur(field);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ remindWeighWeekendMinute: 630 });
  });

  it("saves a weekday time as the weekday minute", async () => {
    const { patches } = mount(SPLIT);

    const field = await screen.findByTestId("remind-day-time");
    fireEvent.change(field, { target: { value: "21:15" } });
    fireEvent.blur(field);

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ remindDayMinute: 1275 });
  });

  /** Nonsense is put back rather than saved, in both columns. */
  it("restores the shown time when what was typed is not a time", async () => {
    const { patches } = mount(SPLIT);

    const field = (await screen.findByTestId("remind-weigh-weekend-time")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "kvart i" } });
    fireEvent.blur(field);

    expect(field.value).toBe("09:00");
    expect(patches).toEqual([]);
  });
});
