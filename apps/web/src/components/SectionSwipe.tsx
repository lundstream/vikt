import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { usePrefersReducedMotion } from "../lib/tokens.js";

/**
 * Moving between sections with a thumb (D154).
 *
 * A phone gets four destinations in a bar at the bottom, and reaching the one
 * beside the current page means aiming at a 72 px target with the hand that is
 * also holding the phone. A horizontal swipe is the gesture every other app on
 * the device already uses for the same thing, and it costs nothing to somebody
 * who does not know it is there.
 *
 * The whole design problem is **when not to fire**, because a page of this app
 * is full of things that are also horizontal: the trend chart, the range
 * sliders on Dagen, a scrolling row of days. Every guard below is one of those,
 * and each is a case where firing would be worse than doing nothing.
 */

/**
 * The strip along either edge the gesture will not start in.
 *
 * Both iOS and Android put their own back gesture there, and a touch that
 * starts inside it belongs to the operating system. Competing with it means
 * either the app moves and the OS also goes back, or neither is sure, and the
 * failure is invisible to anybody testing on a desktop.
 */
export const EDGE_GUARD_PX = 24;

/** How far a touch travels before it is anything but a tap. */
export const CLAIM_PX = 12;

/**
 * How much horizontal movement has to beat vertical before the gesture claims
 * the touch.
 *
 * A page that scrolls is the common case and a swipe is the rare one, so the
 * rare one has to prove itself: the movement must be clearly horizontal, not
 * merely more horizontal than vertical. A diagonal flick while reading stays a
 * scroll.
 */
export const AXIS_RATIO = 1.5;

/** Past a quarter of the screen, the section changes on release. */
export const COMPLETE_FRACTION = 0.25;

/** ...or a flick: px per millisecond, with a floor so a twitch is not a flick. */
export const COMPLETE_VELOCITY = 0.5;
export const FLICK_MIN_PX = 48;

/** Short. This is feedback on a decision already made, not an animation. */
export const SLIDE_MS = 200;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** How far past the first or last section the page will move. */
const RUBBER = 0.25;

/**
 * Whether a touch starting here belongs to something else.
 *
 * Walked from the touch target up to the track, because the thing that owns the
 * horizontal axis is usually an ancestor of what was actually touched: a finger
 * lands on a `path` inside the chart's `svg`, or on the track of a slider.
 *
 * Three cases, and the third is the general one the first two are instances of:
 * anything that can scroll sideways has its own use for a sideways drag.
 */
export function ownedByContent(target: EventTarget | null, track: Element | null): boolean {
  let node = target instanceof Element ? target : null;

  while (node && node !== track) {
    if (node.hasAttribute("data-swipe-ignore")) return true;
    if (node instanceof HTMLInputElement && node.type === "range") return true;

    const style = window.getComputedStyle(node);
    const scrolls = style.overflowX === "auto" || style.overflowX === "scroll";
    if (scrolls && node.scrollWidth > node.clientWidth) return true;

    node = node.parentElement;
  }

  return false;
}

/**
 * Which way the new section lies from the old one.
 *
 * `+1` is forward, and forward is also the answer for a destination that is not
 * in the bar at all: the Mer sheet's places have no position in this order, and
 * a slide has to go somewhere. Taking the direction from the order rather than
 * from the gesture is what makes a tap in the bar and a swipe produce the same
 * movement, which is the point of having one at all.
 */
export function directionBetween(order: readonly string[], from: string, to: string): 1 | -1 {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return 1;
  return b < a ? -1 : 1;
}

/**
 * Back to no transform at all, rather than to `translate3d(0,0,0)`.
 *
 * Not tidiness. A transform makes an element the containing block for every
 * `position: fixed` descendant, and the sheets this app opens are fixed and
 * live inside the page. Leaving an identity transform behind would pin them to
 * the content column instead of the viewport, on every screen, for ever after
 * the first swipe. `will-change` does the same thing and comes off with it.
 */
function clearTransform(element: HTMLElement): void {
  element.style.transition = "";
  element.style.transform = "";
  element.style.willChange = "";
}

export function SectionSwipe({
  order,
  children,
}: {
  /** The sections, in the order the navigation draws them. */
  order: readonly string[];
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();

  const track = useRef<HTMLDivElement>(null);
  /** Where the finger let go, so the incoming section starts from there. */
  const handoff = useRef(0);
  const previous = useRef(pathname);

  /** Once the slide has finished the element goes back to having no transform. */
  useEffect(() => {
    const element = track.current;
    if (!element) return;

    const done = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === "transform") {
        clearTransform(element);
      }
    };

    element.addEventListener("transitionend", done);
    return () => element.removeEventListener("transitionend", done);
  }, []);

  /**
   * Slide the new section in.
   *
   * In a layout effect, before paint, so the first frame of the new page is
   * already at its starting offset rather than flashing at zero.
   *
   * It starts at `width + handoff` rather than at a full width, which is what
   * makes a completed swipe continuous: the page picks up exactly where the
   * finger left it. After a tap the handoff is zero and it is a plain slide.
   */
  useLayoutEffect(() => {
    if (previous.current === pathname) return;

    const direction = directionBetween(order, previous.current, pathname);
    previous.current = pathname;

    const element = track.current;
    const offset = handoff.current;
    handoff.current = 0;

    if (!element || reduced) return;

    const width = element.offsetWidth || window.innerWidth;
    element.style.willChange = "transform";
    element.style.transition = "none";
    element.style.transform = `translate3d(${direction * width + offset}px, 0, 0)`;

    const frame = requestAnimationFrame(() => {
      element.style.transition = `transform ${SLIDE_MS}ms ${EASING}`;
      element.style.transform = "translate3d(0, 0, 0)";
    });

    return () => cancelAnimationFrame(frame);
  }, [pathname, order, reduced]);

  /**
   * The gesture itself, on listeners added by hand.
   *
   * `touchmove` has to be non-passive so a claimed gesture can stop the page
   * scrolling under it, and React attaches its own touch listeners passively.
   * `touch-action` would have been simpler and is wrong here: it applies to
   * everything under the element, so declaring `pan-y` on the content would
   * break every horizontally scrolling thing inside it, which is precisely the
   * set of things the guards exist to protect.
   */
  useEffect(() => {
    const element = track.current;
    if (!element) return;

    /** Phone only, matching the breakpoint where the bottom bar appears. */
    const phone = window.matchMedia("(max-width: 639px)");

    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let previousX = 0;
    let previousT = 0;
    let index = -1;
    let claimed = false;
    let active = false;

    const follow = (x: number) => {
      if (reduced) return;
      element.style.willChange = "transform";
      element.style.transition = "none";
      element.style.transform = `translate3d(${x}px, 0, 0)`;
    };

    const settle = () => {
      if (reduced) return;
      element.style.transition = `transform ${SLIDE_MS}ms ${EASING}`;
      element.style.transform = "translate3d(0, 0, 0)";
    };

    const onStart = (event: TouchEvent) => {
      active = false;
      claimed = false;

      if (!phone.matches) return;
      // Two fingers is a pinch, and a pinch is not this.
      if (event.touches.length !== 1) return;

      const touch = event.touches[0]!;
      if (
        touch.clientX <= EDGE_GUARD_PX ||
        touch.clientX >= window.innerWidth - EDGE_GUARD_PX
      ) {
        return;
      }
      if (ownedByContent(event.target, element)) return;

      index = order.indexOf(pathname);
      if (index === -1) return;

      startX = touch.clientX;
      startY = touch.clientY;
      lastX = startX;
      previousX = startX;
      lastT = event.timeStamp;
      previousT = lastT;
      active = true;
    };

    const onMove = (event: TouchEvent) => {
      if (!active) return;

      const touch = event.touches[0];
      if (!touch) return;

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!claimed) {
        /**
         * Vertical first, because a page that scrolls is what a finger is
         * usually doing. Once a touch has been read as a scroll it stays one
         * for the rest of its life, rather than flipping halfway down.
         */
        if (Math.abs(dy) > CLAIM_PX && Math.abs(dy) >= Math.abs(dx)) {
          active = false;
          return;
        }
        if (!(Math.abs(dx) > CLAIM_PX && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO)) return;
        claimed = true;
      }

      // Claimed, so the page must not also scroll under the finger.
      if (event.cancelable) event.preventDefault();

      previousX = lastX;
      previousT = lastT;
      lastX = touch.clientX;
      lastT = event.timeStamp;

      /**
       * Past the first section or the last one the page still moves, a quarter
       * as far. Nothing happens on release, and the resistance is what says so
       * before the release rather than after it.
       */
      const atEnd = (dx > 0 && index === 0) || (dx < 0 && index === order.length - 1);
      follow(atEnd ? dx * RUBBER : dx);
    };

    const onEnd = (event: TouchEvent) => {
      if (!active) return;
      active = false;
      if (!claimed) return;

      const dx = lastX - startX;
      const elapsed = Math.max(1, lastT - previousT);
      const velocity = Math.abs(lastX - previousX) / elapsed;
      const width = element.offsetWidth || window.innerWidth;

      const far = Math.abs(dx) > width * COMPLETE_FRACTION;
      const flick = velocity > COMPLETE_VELOCITY && Math.abs(dx) > FLICK_MIN_PX;
      const wanted = index + (dx < 0 ? 1 : -1);

      if ((far || flick) && wanted >= 0 && wanted < order.length) {
        handoff.current = reduced ? 0 : dx;
        // So a completed swipe cannot also register as a tap on whatever
        // happens to be under the finger when it lifts.
        if (event.cancelable) event.preventDefault();
        navigate(order[wanted]!);
        return;
      }

      settle();
    };

    const onCancel = () => {
      if (!active) return;
      active = false;
      if (claimed) settle();
    };

    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onCancel);

    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onCancel);
    };
  }, [order, pathname, navigate, reduced]);

  return (
    <div ref={track} data-testid="section-track">
      {children}
    </div>
  );
}
