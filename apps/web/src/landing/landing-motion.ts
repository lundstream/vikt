import { FLICKER_READINGS, SETTLED_TREND } from "./seeded.js";

/**
 * The landing page's behaviour (D173).
 *
 * Everything that can be a CSS animation is one, in `landing.css`. What is left
 * needs to know something CSS cannot: whether an element has been seen, what a
 * number should count towards, and whether the tab is still in front of
 * somebody. That is this file, and it is about a hundred lines of plain DOM.
 *
 * **No library.** §5's motion rule and this page's budget both point the same
 * way: the Web Animations API and `IntersectionObserver` are in every browser
 * this app supports, and a scroll library is 30 kB to do what
 * `animation-timeline` does in four lines.
 *
 * **Reduced motion is checked once, here, and everything below returns early.**
 * The stylesheet already renders the finished page; what this adds would be
 * motion on top of it, so the honest response to the preference is to do
 * nothing at all rather than to do it faster.
 */

const REDUCED = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return window.matchMedia?.(REDUCED).matches ?? false;
}

/** Swedish figures: space as the thousands separator, no decimals. */
function formatKcal(value: number): string {
  return Math.round(value).toLocaleString("sv-SE");
}

/**
 * Count one figure up to the number already written in the DOM.
 *
 * The final text is rendered server-side-shaped — it is in the markup before
 * any of this runs — so a reader with no JavaScript, or with reduced motion,
 * sees the figure rather than a zero. Counting starts at 60 % of it, which
 * keeps the digit count constant, and with tabular figures that means the
 * element never changes width: this page is measured for layout shift.
 */
function countTo(element: HTMLElement, target: number): void {
  const from = Math.round(target * 0.6);
  const start = performance.now();
  const duration = 900;

  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Ease out: a measurement arriving, slowing as it settles.
    const eased = 1 - (1 - t) ** 3;
    element.textContent = formatKcal(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else element.textContent = formatKcal(target);
  };

  requestAnimationFrame(step);
}

/**
 * The daily number, flickering through plausible readings before it settles on
 * what the trend says.
 *
 * This is the section's argument in one element: the same body, weighed on six
 * different mornings, is six different numbers, and the seventh is the only one
 * that means anything. It runs once, for about a second, and then stops.
 */
function flicker(element: HTMLElement): void {
  const readings = [...FLICKER_READINGS];
  let index = 0;
  const every = 110;
  const ticks = Math.round(1000 / every);

  const id = window.setInterval(() => {
    element.textContent = readings[index % readings.length]!.replace(".", ",");
    index += 1;
    if (index >= ticks) {
      window.clearInterval(id);
      element.textContent = SETTLED_TREND.replace(".", ",");
    }
  }, every);
}

/**
 * Reveal once and stop watching.
 *
 * "Everything that moves, stops" includes moving again on the way back up: an
 * element that re-animates every time it crosses the viewport is a page that
 * will not hold still while somebody reads it.
 */
function revealOnce(onReveal: (element: HTMLElement) => void): IntersectionObserver {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        onReveal(entry.target as HTMLElement);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.2 },
  );
  return observer;
}

/**
 * The finished page, with nothing left to animate.
 *
 * Used for reduced motion, and for any environment with no
 * `IntersectionObserver` at all: without it nothing would ever add `.revealed`,
 * and a page whose sections are waiting for an observer that does not exist is
 * an empty page. §5's rule is the final frame, not a broken one, and "the
 * browser cannot do the animation" is the same case as "the reader asked for no
 * animation".
 */
function renderFinalFrame(root: ParentNode): void {
  for (const element of root.querySelectorAll(".reveal")) element.classList.add("revealed");
  for (const element of root.querySelectorAll(".noise-line")) element.classList.add("drawn");
}

export function startLandingMotion(root: ParentNode = document): () => void {
  const cleanups: (() => void)[] = [];
  const canObserve = typeof IntersectionObserver !== "undefined";

  /* ------------------------------------------------------------ header -- */

  /**
   * The scrim appears once the page has scrolled, and not before: a bar with a
   * background at the top of an unscrolled page separates nothing from nothing.
   *
   * Driven by a sentinel rather than a scroll listener, so nothing runs on the
   * main thread while somebody is scrolling.
   */
  const header = root.querySelector<HTMLElement>("[data-landing-header]");
  const sentinel = root.querySelector("[data-scroll-sentinel]");
  if (canObserve && header && sentinel) {
    const watcher = new IntersectionObserver(
      ([entry]) => header.classList.toggle("scrolled", !entry?.isIntersecting),
      { threshold: 0 },
    );
    watcher.observe(sentinel);
    cleanups.push(() => watcher.disconnect());
  }

  /* ------------------------------------------------- the drifting field -- */

  /**
   * Paused when the tab is hidden (§5). An animation nobody is looking at is a
   * timer keeping a phone's compositor awake.
   */
  const hero = root.querySelector<HTMLElement>("[data-hero]");
  if (hero) {
    const sync = () => hero.classList.toggle("drift-paused", document.hidden);
    document.addEventListener("visibilitychange", sync);
    sync();
    cleanups.push(() => document.removeEventListener("visibilitychange", sync));
  }

  if (!canObserve || prefersReducedMotion()) {
    renderFinalFrame(root);
    return () => {
      for (const clean of cleanups) clean();
    };
  }

  /* ------------------------------------------------------------ reveals -- */

  const reveals = revealOnce((element) => element.classList.add("revealed"));
  for (const element of root.querySelectorAll(".reveal")) reveals.observe(element);
  cleanups.push(() => reveals.disconnect());

  /* ------------------------ the line through the noise, where view() is not -- */

  /**
   * The scroll-driven draw is CSS. Where the browser has no scroll timeline the
   * same element gets a time-based draw when it is reached, which says the same
   * thing a moment earlier: the reader is no longer holding the pen, but the
   * line still draws through the noise rather than appearing finished.
   */
  const hasTimeline = CSS.supports?.("animation-timeline: view()") ?? false;
  if (!hasTimeline) {
    const lines = revealOnce((element) => element.classList.add("drawn"));
    for (const element of root.querySelectorAll(".noise-line")) lines.observe(element);
    cleanups.push(() => lines.disconnect());
  }

  /* ------------------------------------------------------- the figures -- */

  const figures = revealOnce((element) => {
    const target = Number(element.dataset.countTo);
    if (Number.isFinite(target)) countTo(element, target);
  });
  for (const element of root.querySelectorAll<HTMLElement>("[data-count-to]")) {
    figures.observe(element);
  }
  cleanups.push(() => figures.disconnect());

  /* -------------------------------------------------- the daily reading -- */

  const flickers = revealOnce((element) => flicker(element));
  for (const element of root.querySelectorAll<HTMLElement>("[data-flicker]")) {
    flickers.observe(element);
  }
  cleanups.push(() => flickers.disconnect());

  return () => {
    for (const clean of cleanups) clean();
  };
}
