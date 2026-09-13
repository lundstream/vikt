/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { AppShell } from "../../src/components/AppShell.js";

/**
 * The Admin entry appears for admins and for nobody else (D100).
 *
 * D89 left the route unlinked, so the only way in was typing the URL. That
 * protected nothing — `/admin` is in the bundle every account downloads — and it
 * cost the owner a URL to remember. The link is now in the Mer sheet, behind
 * `me.isAdmin`.
 *
 * What this test is *not* is an authorisation test. `me.isAdmin` decides whether
 * a link is drawn and authorises nothing; `requireAdmin` reads the flag from the
 * database on every request and answers 404 without it. Hiding the link is
 * tidiness, and the 404 is the security property.
 */

function me(isAdmin: boolean, pendingRequests = 0) {
  return {
    pendingRequests,
    id: "00000000-0000-0000-0000-000000000001",
    email: "someone@example.test",
    displayName: "Someone",
    createdAt: "2026-01-01T00:00:00.000Z",
    isAdmin,
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
}

function openMore(isAdmin: boolean, pending = 0) {
  renderRoute(<AppShell>{null}</AppShell>, {
    path: "/",
    responses: [{ match: "/api/me", body: me(isAdmin, pending) }],
  });
  fireEvent.click(screen.getByTestId("nav-more"));
}

describe("the Mer sheet", () => {
  afterEach(cleanup);

  it("offers Admin to an admin", async () => {
    openMore(true);
    await waitFor(() => expect(screen.getByTestId("more-admin")).toBeTruthy());
    expect(screen.getByTestId("more-admin").textContent).toContain("Administration");
  });

  it("does not offer it to anybody else", async () => {
    openMore(false);
    // The sheet is open and populated, and the admin row is simply not in it.
    await waitFor(() => expect(screen.getByTestId("more-installningar")).toBeTruthy());
    expect(screen.queryByTestId("more-admin")).toBeNull();
  });

  /** The other four entries are there either way, each with its icon. */
  it("always offers data, profile, settings and sign out", async () => {
    openMore(false);
    await waitFor(() => expect(screen.getByTestId("more-data")).toBeTruthy());

    for (const id of ["more-data", "more-profile", "more-installningar", "more-signout"]) {
      expect(screen.getByTestId(id).querySelector("svg"), `${id} has no icon`).toBeTruthy();
    }
  });
});

/**
 * The marker on the admin entry (D129).
 *
 * A dot rather than a count, on the same reasoning D108 gives for the news one:
 * the number is never large enough to be information, and a numbered badge is
 * the shape of an app that wants attention rather than one that has something
 * to say. Gran, because a request waiting is work rather than a failure.
 *
 * It is computed from the rows, so it appears whether or not the mail went out
 * and whether or not this admin has the mail turned off.
 */
describe("the pending-request marker", () => {
  afterEach(cleanup);

  it("marks the admin row when something is waiting", async () => {
    openMore(true, 2);
    await waitFor(() => expect(screen.getByTestId("more-admin")).toBeTruthy());

    expect(screen.getByTestId("more-pending")).toBeTruthy();
    // The Mer button carries it too, since Admin is behind the sheet on a phone.
    expect(screen.getByTestId("more-unread")).toBeTruthy();
  });

  it("shows nothing when nothing is waiting", async () => {
    openMore(true, 0);
    await waitFor(() => expect(screen.getByTestId("more-admin")).toBeTruthy());

    expect(screen.queryByTestId("more-pending")).toBeNull();
  });

  /** And never for an account that has no admin row to mark. */
  it("shows nothing to a non-admin", async () => {
    openMore(false, 3);
    await waitFor(() => expect(screen.getByTestId("more-signout")).toBeTruthy());

    expect(screen.queryByTestId("more-admin")).toBeNull();
    expect(screen.queryByTestId("more-pending")).toBeNull();
  });
});
