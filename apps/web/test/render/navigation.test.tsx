/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { AppShell } from "../../src/components/AppShell.js";
import { destinationsFor, inBar } from "../../src/components/AppShell.js";

/**
 * The two navigation surfaces cover the same places (D115).
 *
 * They had drifted apart in both directions, and neither could see it. The
 * sidebar listed five destinations and put Inställningar in its footer as a bare
 * underlined link with no icon; the Mer sheet listed six and a sign-out. So a
 * desktop account had **no way to sign out at all**, no Nyheter, no Profil and
 * no Administration, and none of it was reported as four separate bugs, because
 * from inside either surface everything looked complete.
 *
 * That is the failure this file exists to make impossible to repeat, so it
 * checks two different things:
 *
 *  - **against the router**, that every route with a screen is in the
 *    destination list, so adding a screen fails here until it is listed;
 *  - **against the rendered document**, that the sidebar draws the same set the
 *    bar and the sheet draw between them.
 *
 * The second one is rendered rather than read out of the source on purpose. The
 * list being right is not the property anybody cares about; the surfaces being
 * right is, and a surface can render from the right list and still filter it
 * wrongly.
 */

const APP = readFileSync(
  path.resolve(import.meta.dirname, "../../src/App.tsx"),
  "utf8",
);

/**
 * Routes that render a screen for a signed-in account.
 *
 * `signedIn(...)` is the marker: the auth screens, the redirect for `/samband`
 * and the catch-all do not use it, and none of the three is a place to navigate
 * to.
 */
function signedInRoutes(): string[] {
  return [...APP.matchAll(/<Route\s+path="([^"]+)"\s+element=\{signedIn\(/g)].map(
    (match) => match[1]!,
  );
}

/**
 * The one route with a screen that is deliberately unreachable.
 *
 * `/diagnostik` exists so the BarcodeDetector path can be checked on a real
 * phone, which no headless browser can stand in for. It is a probe rather than
 * a place, and putting it in the navigation would offer every account a screen
 * that answers a question only the owner is asking.
 */
const UNLISTED = new Set(["/diagnostik"]);

function me(isAdmin: boolean) {
  return {
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

function mount(isAdmin: boolean) {
  renderRoute(<AppShell>{null}</AppShell>, {
    path: "/",
    responses: [{ match: "/api/me", body: me(isAdmin) }],
  });
}

/** Every `to` a surface renders, read off the document rather than the source. */
function renderedPaths(root: HTMLElement): string[] {
  return [...root.querySelectorAll("a[href]")]
    .map((node) => node.getAttribute("href")!)
    .map((href) => href.replace(/^\/app(?=\/|$)/, "") || "/");
}

describe("the destination list", () => {
  afterEach(cleanup);

  /**
   * The check that fails when a route is added and not listed, which is the one
   * this file is really for.
   */
  it("holds every route that has a screen", () => {
    const listed = new Set(destinationsFor(true).map((destination) => destination.to));
    const routes = signedInRoutes().filter((route) => !UNLISTED.has(route));

    expect(routes.length, "no signed-in routes found, the regex has gone stale").
      toBeGreaterThan(5);

    const missing = routes.filter((route) => !listed.has(route));
    expect(
      missing,
      `these routes have a screen and no way to reach it: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  /** And nothing points at a route that does not exist. */
  it("points only at routes the app serves", () => {
    const routes = new Set(signedInRoutes());
    const dangling = destinationsFor(true)
      .map((destination) => destination.to)
      .filter((to) => !routes.has(to));

    expect(dangling, `these destinations have no route: ${dangling.join(", ")}`).toEqual([]);
  });

  it("splits into a bar of four and an overflow", () => {
    // Four, and the fifth slot is the Mer button. Six targets across 360 px is
    // 60 px each, below what a thumb hits reliably.
    expect(destinationsFor(true).filter(inBar)).toHaveLength(4);
    expect(destinationsFor(true).filter((d) => !inBar(d)).length).toBeGreaterThan(0);
  });
});

describe("the two surfaces", () => {
  afterEach(cleanup);

  /**
   * The property the drift broke: what the sidebar offers and what the bar and
   * sheet offer between them are the same places.
   */
  it("cover the same set, for an ordinary account", async () => {
    mount(false);
    await waitFor(() => expect(screen.getByTestId("side-installningar")).toBeTruthy());

    const sidebar = new Set(renderedPaths(screen.getByTestId("sidebar")));

    fireEvent.click(screen.getByTestId("nav-more"));
    await waitFor(() => expect(screen.getByTestId("more-sheet")).toBeTruthy());

    const phone = new Set([
      ...renderedPaths(screen.getByTestId("bottom-bar")),
      ...renderedPaths(screen.getByTestId("more-sheet")),
    ]);

    expect([...sidebar].sort()).toEqual([...phone].sort());
  });

  it("cover the same set for an admin, including Administration", async () => {
    mount(true);
    await waitFor(() => expect(screen.getByTestId("side-admin")).toBeTruthy());

    const sidebar = new Set(renderedPaths(screen.getByTestId("sidebar")));

    fireEvent.click(screen.getByTestId("nav-more"));
    await waitFor(() => expect(screen.getByTestId("more-admin")).toBeTruthy());

    const phone = new Set([
      ...renderedPaths(screen.getByTestId("bottom-bar")),
      ...renderedPaths(screen.getByTestId("more-sheet")),
    ]);

    expect([...sidebar].sort()).toEqual([...phone].sort());
    expect(sidebar.has("/admin")).toBe(true);
  });

  /** Administration is drawn for admins and for nobody else, on both (D100). */
  it("keep Administration out of both for a non-admin", async () => {
    mount(false);
    await waitFor(() => expect(screen.getByTestId("side-installningar")).toBeTruthy());
    expect(screen.queryByTestId("side-admin")).toBeNull();

    fireEvent.click(screen.getByTestId("nav-more"));
    await waitFor(() => expect(screen.getByTestId("more-installningar")).toBeTruthy());
    expect(screen.queryByTestId("more-admin")).toBeNull();
  });

  /**
   * Sign out exists on both. It was in the sheet only, and the sheet is
   * `sm:hidden`, so a desktop account could not leave.
   */
  it("both offer a way out", async () => {
    mount(false);
    await waitFor(() => expect(screen.getByTestId("side-signout")).toBeTruthy());

    fireEvent.click(screen.getByTestId("nav-more"));
    await waitFor(() => expect(screen.getByTestId("more-signout")).toBeTruthy());
  });

  /** And every row on both surfaces has its icon, including Inställningar. */
  it("draw an icon on every row", async () => {
    mount(true);
    await waitFor(() => expect(screen.getByTestId("side-admin")).toBeTruthy());

    for (const node of screen.getByTestId("sidebar").querySelectorAll("a, button")) {
      expect(
        node.querySelector("svg"),
        `sidebar row "${node.textContent?.trim()}" has no icon`,
      ).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId("nav-more"));
    await waitFor(() => expect(screen.getByTestId("more-sheet")).toBeTruthy());

    for (const node of screen.getByTestId("more-sheet").querySelectorAll("a")) {
      expect(
        node.querySelector("svg"),
        `sheet row "${node.textContent?.trim()}" has no icon`,
      ).toBeTruthy();
    }
  });
});
