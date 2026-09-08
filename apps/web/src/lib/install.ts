import { useEffect, useState } from "react";

/**
 * Offering to install the app, on the platforms that let you offer (D116).
 *
 * ## Three states, not two
 *
 * The obvious shape is "show a button, call `prompt()`". That is wrong on two
 * of the three platforms this app is used on:
 *
 *  - **Chromium** fires `beforeinstallprompt`, which can be stashed and
 *    replayed later from a click. This is the only place a real button exists.
 *  - **iOS Safari** never fires it and has no API at all. The only route is
 *    Share, then "Lägg till på hemskärmen", done by hand. A button there would
 *    be a button that cannot work, so the offer is instructions instead.
 *  - **Already installed**, where the whole thing is noise. Offering to install
 *    an app to somebody standing inside it is the kind of detail that makes
 *    software feel like it is not paying attention.
 *
 * So this reports which of the three the visitor is in and lets the caller
 * render accordingly, rather than exporting a boolean that flattens two very
 * different situations into one.
 *
 * ## Why the event has to be captured at module load
 *
 * `beforeinstallprompt` fires **once**, early, usually before React has
 * mounted. A hook that starts listening on mount misses it on a cold load and
 * then reports "not installable" for a browser that offered. So the listener is
 * installed at import time and the event is held in a module variable; the hook
 * reads what is already there and subscribes for the case where it has not
 * fired yet.
 *
 * ## What the platform still decides
 *
 * Chromium fires the event only when its own installability criteria are met:
 * a manifest with icons, a service worker, HTTPS, and in recent versions some
 * engagement heuristic. There is no way to force it, and no way to ask "would
 * you fire?". Absent event means no button, and that is not a bug to work
 * around.
 */

/** The Chromium-only event. Not in lib.dom, because it is not standardised. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let captured: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Chromium shows its own mini-infobar otherwise, which is a second offer in
    // a place the app does not control and cannot style.
    event.preventDefault();
    captured = event as InstallPromptEvent;
    announce();
  });

  /**
   * Installed, possibly from the browser's own menu rather than from our
   * button. The stashed event is spent either way and the control has to go.
   */
  window.addEventListener("appinstalled", () => {
    captured = null;
    announce();
  });
}

/**
 * Whether the app is running as an installed app rather than in a tab.
 *
 * Two checks because the platforms disagree: `display-mode: standalone` is the
 * standard one, and `navigator.standalone` is what iOS Safari has instead. The
 * same pair `Diagnostics.tsx` uses, deliberately, so the two screens cannot
 * report different answers about the same phone.
 */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * An iPhone or iPad, where installing is a manual gesture.
 *
 * Not "is it Safari": every browser on iOS is WebKit underneath, none of them
 * fires `beforeinstallprompt`, and all of them install through the same Share
 * sheet. So the check is the platform, and Chrome or Firefox on an iPhone gets
 * the instructions rather than a button that cannot work.
 */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)
  );
}

export type InstallState =
  /** Already an app. Offer nothing. */
  | { kind: "installed" }
  /** A real prompt is available. */
  | { kind: "promptable"; install: () => Promise<"accepted" | "dismissed"> }
  /** No API. Tell them where the Share button is. */
  | { kind: "manual" }
  /** Nothing to say: not installed, no event, and no instructions that would help. */
  | { kind: "unavailable" };

export function useInstall(): InstallState {
  const [, bump] = useState(0);
  const [standalone] = useState(isStandalone);

  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (standalone) return { kind: "installed" };

  if (captured !== null) {
    const event = captured;
    return {
      kind: "promptable",
      install: async () => {
        await event.prompt();
        const { outcome } = await event.userChoice;
        /**
         * Spent either way. The specification allows a prompt to be shown once
         * per event, and calling it twice throws; dropping it means the control
         * disappears after a decision rather than offering a button that will
         * fail.
         */
        captured = null;
        announce();
        return outcome;
      },
    };
  }

  if (isIos()) return { kind: "manual" };

  return { kind: "unavailable" };
}
