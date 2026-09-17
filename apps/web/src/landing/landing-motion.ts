import { MORNING_CYCLE_MS, MORNING_READINGS } from "./seeded.js";

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

/**
 * Swedish figures: space as the thousands separator, a comma for the decimal.
 *
 * `shared`'s `formatDecimal` says the same thing and is the one every screen in
 * the app goes through. It is not imported here: this page's budget is 15 kB of
 * its own code, and both of these figures are also rendered by React into the
 * markup before this runs, from `seeded.ts`, which does go through the shared
 * rules. So what this produces has to match a string already on the page, and
 * a disagreement about a comma would be visible the moment the count-up ends.
 */
function swedish(value: number, decimals: number): string {
  return value.toLocaleString("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
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
  const start = performance.now();
  const duration = 900;
  const digits = digitsOf(element);

  /*
    A weight is one decimal and a kilocalorie is none (§4.1), and this counted
    every figure as whole. It was only ever pointed at kcal until the trend card
    started using it, and then 84,5 counted up and landed on "84": a weight
    written the way this app never writes one, on the figure whose whole job is
    to be the trend.

    Read off the target rather than passed in, because the target is the value
    the page is showing and its shape is the answer.
  */
  const decimals = Number.isInteger(target) ? 0 : 1;
  const write = (value: number) => swedish(value, decimals);

  /* Far enough back to read as counting, near enough not to be a different number. */
  const from = Number((target * 0.6).toFixed(decimals));

  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    // Ease out: a measurement arriving, slowing as it settles.
    const eased = 1 - (1 - t) ** 3;
    digits.textContent = write(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
    else digits.textContent = write(target);
  };

  requestAnimationFrame(step);
}

/**
 * The daily number, stepping through the fixture's readings (D180).
 *
 * The left card's whole content is that **this number is different every
 * morning**, so it keeps changing: one reading at a time, swapped outright.
 * Tabular figures, so nothing shifts while it does.
 *
 * ## Why it loops, where §5 says everything that moves stops
 *
 * Because what it says has no end state. A trend settles and a line finishes
 * drawing; a daily weight does not, and a card that showed one reading and
 * stopped would be making the opposite point to the one beside it. §5's
 * exception for a thing with no end state is written for the **background**,
 * and this is the subject, so it is not covered by it: D180 carries its own
 * reasoning.
 *
 * What keeps it honest is that it runs **only while it is on screen**. An
 * observer starts and stops it, so a reader who has scrolled past pays nothing
 * for it, and neither does a tab nobody is looking at.
 */
function cycleReadings(element: HTMLElement): () => void {
  const digits = digitsOf(element);
  let index = 0;
  let timer: number | null = null;

  /*
    Outright, with no fade (D181). The card's content is the number, and a
    third of every cycle spent dissolving draws the eye to the change rather
    than to what changed. A scale shows one reading, then another.
  */
  const step = () => {
    index = (index + 1) % MORNING_READINGS.length;
    digits.textContent = MORNING_READINGS[index]!;
  };

  const watcher = new IntersectionObserver(
    ([entry]) => {
      const onScreen = entry?.isIntersecting === true;
      if (onScreen && timer === null) timer = window.setInterval(step, MORNING_CYCLE_MS);
      else if (!onScreen && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    },
    { threshold: 0.2 },
  );
  watcher.observe(element);

  return () => {
    watcher.disconnect();
    if (timer !== null) window.clearInterval(timer);
  };
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

  /*
    Only where motion is wanted. Under reduced motion the card keeps the one
    reading React rendered, which is the finished state of a thing whose whole
    content is that it changes: there is no better still frame of "this number
    is different every day" than one of them.
  */
  if (!prefersReducedMotion()) {
    for (const element of root.querySelectorAll<HTMLElement>("[data-cycle]")) {
      cleanups.push(cycleReadings(element));
    }
  }

  return () => {
    for (const clean of cleanups) clean();
  };
}
