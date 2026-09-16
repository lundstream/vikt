import { FLICKER_READINGS, MORNING_STEP_MS, MORNINGS, SETTLED_TREND } from "./seeded.js";

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
/**
 * The digits of a figure, without its unit.
 *
 * A figure is `<span data-figure-value>2 536</span><span>kcal</span>`, so
 * writing `textContent` on the figure would delete the unit on the first frame
 * of the count (profile page 5: the unit is always there, smaller and in Sten).
 */
function digitsOf(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>("[data-figure-value]") ?? element;
}

function countTo(element: HTMLElement, target: number): void {
  const from = Math.round(target * 0.6);
  const start = performance.now();
  const duration = 900;

  const digits = digitsOf(element);

  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Ease out: a measurement arriving, slowing as it settles.
    const eased = 1 - (1 - t) ** 3;
    digits.textContent = formatKcal(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else digits.textContent = formatKcal(target);
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
  const digits = digitsOf(element);
  const readings = [...FLICKER_READINGS];
  let index = 0;
  const every = 110;
  /*
    It settles when the last of the fourteen mornings has landed, which is what
    the two together are saying: those readings, this figure. Derived from the
    step rather than typed as a round number next to it, so moving one moves
    both (D179).
  */
  const ticks = Math.max(1, Math.round((MORNINGS.length - 1) * MORNING_STEP_MS) / every);

  const id = window.setInterval(() => {
    digits.textContent = readings[index % readings.length]!;
    index += 1;
    if (index >= ticks) {
      window.clearInterval(id);
      digits.textContent = SETTLED_TREND;
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
  /*
    The fourteen mornings carry their own delay off `.revealed`, and the rule
    for reduced motion zeroes it, so revealing their list is enough. They are
    marked as well as the list, because the list is what the observer watches
    and a reader with no `IntersectionObserver` gets neither otherwise.
  */
  for (const element of root.querySelectorAll(".morning")) element.classList.add("revealed");
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

  /*
    There is no longer anything on this page that runs without an end, so
    nothing here pauses with the tab (D178). The drifting field behind the hero
    was the one exception §5 allowed, and it is gone: at hero size it read as
    dust on the lens, and the graph's own readings are the noise the page is
    actually about.
  */

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

  /*
    There is no scroll-driven anything on this page any more (D179).

    "En dagsvikt är mest brus" used to draw a second trend line with the
    reader's wheel: a listener measured the section's travel past the viewport's
    midline, kept the **maximum** seen so far so the line never undrew itself,
    wrote it to `--progress` and removed itself at 1. All of that was correct,
    and all of it was in service of drawing the page's thesis a second time. The
    section states it in figures now, so the driver has nothing left to drive.

    What remains that is scroll-linked is the phone frames' tilt, and that is
    CSS with no JavaScript behind it (D173's addendum).
  */

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
