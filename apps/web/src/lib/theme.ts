import type { Theme } from "shared";

/**
 * Applying the theme, and remembering it across a cold start (D117).
 *
 * ## Two stores, one source of truth
 *
 * The choice lives on the **account**, because it is a preference about the app
 * and not about a browser: someone who reads at night on a phone reads at night
 * on a laptop. The server is the source of truth and `/api/me` carries it.
 *
 * But the first paint happens long before `/api/me` answers, and a dark app
 * that flashes light for 400 ms every morning is worse than no setting at all.
 * So the value is also mirrored into `localStorage` and read by the inline
 * script in `app/index.html` before any JavaScript module loads. That mirror is
 * a **cache, never an authority**: whatever `/api/me` says wins the moment it
 * arrives, and a device that has never synced simply falls back to `system`.
 *
 * This is the same shape as the cached identity in `session.ts`, for the same
 * reason: a fact that does not go out of date between one morning and the next,
 * needed before the network can answer.
 *
 * ## Why `system` is a value and not a null
 *
 * Following the OS is a choice somebody makes and can come back to. A null
 * meaning "has not chosen" would behave identically and would tempt some future
 * screen into asking a question that has already been answered.
 */

export const THEME_KEY = "vikt.theme";

/** What the OS is asking for, right now. */
function prefersLight(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches === true;
}

/** Whether a given choice means dark, resolving `system` against the OS. */
export function resolvesDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return !prefersLight();
}

/**
 * Puts the theme on `<html>`.
 *
 * A class rather than a data attribute, because `tokens.css` and every
 * `.dark` rule in `index.css` are already keyed on it and changing that would
 * be a large edit for no gain.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolvesDark(theme));
}

/** The cached choice, for the first paint. `system` when there is nothing. */
export function cachedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    // A private window, or storage refused. `system` is the right answer then.
  }
  return "system";
}

export function cacheTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Nothing to do. The account still holds it, so the next load after a sync
    // is correct; only the first frame of a cold start is affected.
  }
}

/**
 * Follows the OS while the app is open, and only where that is what was asked.
 *
 * The listener used to be unconditional, which was right when `system` was the
 * only behaviour. It is not any more: someone who has chosen dark and then
 * turns their laptop light at sunset should not watch this app change with it.
 *
 * Returns the unsubscribe, so a change of choice replaces the listener rather
 * than adding a second one.
 */
export function followSystem(theme: Theme): () => void {
  if (typeof window === "undefined" || theme !== "system") return () => {};

  const query = window.matchMedia("(prefers-color-scheme: light)");
  const listener = () => applyTheme("system");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}
