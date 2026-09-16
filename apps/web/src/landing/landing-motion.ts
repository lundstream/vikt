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
  const ticks = Math.round(1000 / every);

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
  for (const element of root.querySelectorAll<HTMLElement>("[data-progress-section]")) {
    element.style.setProperty("--progress", "1");
  }
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

  /* ------------------------------------------ the line through the noise -- */

  /**
   * Scroll progress, as the **maximum** seen so far.
   *
   * The section's own travel past the viewport's midline, from 0 to 1, written
   * to `--progress`. Two properties matter and both are deliberate:
   *
   * - **it only increases.** Scrolling back up leaves the line drawn, because a
   *   line that undraws itself while somebody scrolls back to re-read the
   *   paragraph beside it is motion without meaning (§5);
   * - **it stops.** Once it reaches 1 the listener removes itself, so a reader
   *   who has passed the section pays nothing for it.
   *
   * This was `animation-timeline: view()`, which is four lines of CSS and runs
   * backwards by design.
   */
  const section = root.querySelector<HTMLElement>("[data-progress-section]");
  if (section) {
    let highest = 0;
    let queued = false;

    const measure = () => {
      queued = false;
      const box = section.getBoundingClientRect();
      const midline = window.innerHeight * 0.55;
      const travel = Math.max(1, box.height * 0.75);
      const seen = Math.min(1, Math.max(0, (midline - box.top) / travel));

      if (seen <= highest) return;
      highest = seen;
      section.style.setProperty("--progress", seen.toFixed(4));
      if (highest >= 1) stop();
    };

    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(measure);
    };

    const stop = () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    measure();
    cleanups.push(stop);
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
