/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { Settings } from "../../src/routes/Settings.js";
import { db } from "../../src/lib/queue/db.js";

/**
 * The question the page asks when the row an edit held is gone (D153).
 *
 * The logic has its own file; what this holds is the thing only the screen can
 * show, which is that the person is offered two answers rather than one dead
 * control. Before this, a 404 was `status: "failed"` and the row carried
 * "Försök igen" and "Kasta": one that sends the identical request to the same
 * absent row forever, and one that throws away a reading somebody took.
 *
 * It also holds the wording, because the conflict section's copy was written
 * about two devices writing one day and every word of it is false here.
 */

afterEach(cleanup);

beforeEach(async () => {
  await db.mutations.clear();
  await db.conflicts.clear();
});

/** A queued edit whose row was deleted, exactly as `send` records it. */
async function seedDeletedRow(): Promise<void> {
  const mutationId = await db.mutations.add({
    clientUuid: "11111111-1111-4111-8111-111111111111",
    kind: "weight-update",
    body: {
      id: "row-1",
      localDate: "2026-08-24",
      baselineWeightKg: 110,
      weightKg: 110.1,
      fromQueue: true,
    },
    localDate: "2026-08-24",
    dateSource: "chosen",
    timezone: "Europe/Stockholm",
    createdAt: "2026-08-24T07:00:00.000Z",
    status: "conflict",
    attempts: 1,
    nextAttemptAt: null,
    failure: {
      status: 404,
      code: "not_found",
      message: "Den vägningen finns inte längre.",
      at: "2026-08-24T08:00:00.000Z",
    },
  });

  await db.conflicts.add({
    kind: "weight-update",
    localDate: "2026-08-24",
    mine: {
      id: "row-1",
      localDate: "2026-08-24",
      baselineWeightKg: 110,
      weightKg: 110.1,
      fromQueue: true,
    },
    // Nothing, because there is nothing. Not a missing value.
    theirs: {},
    reason: "row_gone",
    mutationId,
    createdAt: "2026-08-24T08:00:00.000Z",
    resolvedAt: null,
  });
}

describe("a queued edit whose reading was deleted", () => {
  it("offers two answers, and neither of them is a retry", async () => {
    await seedDeletedRow();
    renderRoute(<Settings />);

    const conflict = await screen.findByTestId(/^use-mine-/);
    expect(conflict.textContent).toBe("Lägg till igen");
    expect(screen.getByTestId(/^keep-server-/).textContent).toBe("Släng den");

    // The inspector's copy of the same question, where the person may well be
    // standing instead.
    expect(screen.getByTestId(/^queue-use-mine-/).textContent).toBe("Lägg till igen");
    expect(screen.getByTestId(/^queue-keep-server-/).textContent).toBe("Släng den");

    // And the controls that could not have worked are not offered.
    expect(screen.queryByTestId(/^retry-/)).toBeNull();
  });

  it("says what happened rather than naming a device that was not involved", async () => {
    await seedDeletedRow();
    renderRoute(<Settings />);

    expect(
      await screen.findByText(/är borttagen, och dagen har ingen vägning alls/),
    ).toBeTruthy();
    expect(screen.getByText(/^Raden är borttagen/)).toBeTruthy();
    // The comparison has one side, since the other one is gone.
    expect(screen.queryByText("Sparad på servern")).toBeNull();
    expect(screen.getByText("Din väntande post")).toBeTruthy();
    // The queued row names itself rather than rendering its own lookup key.
    expect(screen.getByText("Ändrad vägning")).toBeTruthy();
  });

  it("clears the question when the reading is discarded", async () => {
    await seedDeletedRow();
    renderRoute(<Settings />);

    fireEvent.click(await screen.findByTestId(/^keep-server-/));

    await waitFor(async () => {
      expect(await db.mutations.count()).toBe(0);
    });
    expect((await db.conflicts.toArray())[0]?.resolvedAt).not.toBeNull();
  });
});
