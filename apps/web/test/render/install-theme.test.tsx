/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute } from "./harness.js";
import { InstallApp } from "../../src/components/InstallApp.js";
import { ThemeChoice, ThemeApplier } from "../../src/components/ThemeChoice.js";
import { resolvesDark, applyTheme, THEME_KEY } from "../../src/lib/theme.js";

/**
 * Installing, and the theme (D116, D117).
 *
 * The install control has three outcomes and only one of them is a button, so
 * the tests worth having are the two that are not: a platform with no API gets
 * instructions, and an app already installed gets nothing at all. The second is
 * the one a naive implementation gets wrong, because it is the state the
 * developer is never in while writing it.
 */

function me(theme: "system" | "dark" | "light") {
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
      theme,
      lastDrinkOn: null,
      macroOverrides: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
    },
  };
}

/** `matchMedia` is not implemented in jsdom, so every test states what the OS says. */
function osPrefersLight(light: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      matches: query.includes("prefers-color-scheme: light") ? light : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  );
}

describe("the install offer", () => {
  beforeEach(() => {
    osPrefersLight(false);
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152",
      configurable: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * A desktop browser that never fired the event. No button, because there is
   * nothing to open, and no instructions, because there are none worth giving.
   */
  it("shows nothing when the platform offered nothing", () => {
    renderRoute(<InstallApp />, { responses: [] });
    expect(screen.queryByTestId("install-app")).toBeNull();
  });

  /** iOS has no API and does have a gesture, so it gets the gesture. */
  it("shows the manual steps on an iPhone", async () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605",
      configurable: true,
    });

    renderRoute(<InstallApp />, { responses: [] });

    await waitFor(() => expect(screen.getByTestId("install-steps")).toBeTruthy());
    expect(screen.queryByTestId("install-button")).toBeNull();
    expect(screen.getByTestId("install-steps").textContent).toContain("Dela");
  });

  /**
   * The state the control must not appear in, and the one nobody tests because
   * nobody develops in it.
   */
  it("shows nothing at all inside an installed app", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605",
      configurable: true,
    });
    (navigator as { standalone?: boolean }).standalone = true;

    renderRoute(<InstallApp />, { responses: [] });
    expect(screen.queryByTestId("install-app")).toBeNull();

    delete (navigator as { standalone?: boolean }).standalone;
  });
});

describe("the theme choice", () => {
  beforeEach(() => {
    osPrefersLight(false);
    document.documentElement.classList.remove("dark");
    try {
      localStorage.removeItem(THEME_KEY);
    } catch {
      /* jsdom always has it, but the code does not assume so. */
    }
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** The resolution table, which is the whole of the logic. */
  it("resolves the three values against the OS", () => {
    osPrefersLight(false);
    expect(resolvesDark("system")).toBe(true);
    osPrefersLight(true);
    expect(resolvesDark("system")).toBe(false);

    // And an explicit choice ignores the OS in both directions.
    osPrefersLight(true);
    expect(resolvesDark("dark")).toBe(true);
    osPrefersLight(false);
    expect(resolvesDark("light")).toBe(false);
  });

  it("marks the account's current value", async () => {
    renderRoute(<ThemeChoice />, { responses: [{ match: "/api/me", body: me("light") }] });

    await waitFor(() =>
      expect(screen.getByTestId("theme-light").getAttribute("aria-pressed")).toBe("true"),
    );
    expect(screen.getByTestId("theme-dark").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("theme-system").getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * Applied on click rather than after the round trip. A theme that waits on
   * the network feels broken, and the write is one enum on one row.
   */
  it("applies the choice immediately and caches it", async () => {
    osPrefersLight(false);
    renderRoute(<ThemeChoice />, { responses: [{ match: "/api/me", body: me("system") }] });

    await waitFor(() => expect(screen.getByTestId("theme-light")).toBeTruthy());
    fireEvent.click(screen.getByTestId("theme-light"));

    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(false),
    );
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  /**
   * The applier is what makes the setting take effect anywhere but this screen.
   * Mounted in the shell for exactly that reason.
   */
  it("puts the account's theme on the document from anywhere", async () => {
    osPrefersLight(true);
    document.documentElement.classList.remove("dark");

    renderRoute(<ThemeApplier />, { responses: [{ match: "/api/me", body: me("dark") }] });

    // The OS says light and the account says dark; the account wins.
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
  });

  /** And `applyTheme` is the only thing that touches the class. */
  it("toggles the class in both directions", () => {
    osPrefersLight(false);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
