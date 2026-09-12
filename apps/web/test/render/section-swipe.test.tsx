/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { SectionSwipe, directionBetween, EDGE_GUARD_PX } from "../../src/components/SectionSwipe.js";

/**
 * The swipe, and the five times it must not fire (D154).
 *
 * Driven with synthetic touch events, because that is the only way to ask these
 * questions at all: a guard against the operating system's own back gesture, or
 * against a finger that lands on the trend line, is invisible to a click and
 * cannot be reasoned about from the markup.
 *
 * jsdom has no layout, so the track's `offsetWidth` is zero and the component
 * falls back to `window.innerWidth`, which is what these set. That fallback is
 * not a testing affordance: it is what a page that has not been measured yet
 * needs anyway.
 */

const ORDER = ["/", "/dag", "/food", "/framsteg"];
const WIDTH = 360;

let reducedMotion = false;
let phone = true;

beforeEach(() => {
  reducedMotion = false;
  phone = true;
  window.innerWidth = WIDTH;

  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : phone,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
});

afterEach(cleanup);

/**
 * A touch event jsdom will dispatch.
 *
 * Built by hand rather than with `new TouchEvent`, which jsdom does not
 * implement: what the component reads is `touches`, `timeStamp` and the target,
 * and those are all definable on a plain event.
 */
function touch(
  element: Element,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  points: { clientX: number; clientY: number }[],
  timeStamp = 0,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: points });
  Object.defineProperty(event, "changedTouches", { value: points });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  // Inside `act`, because a completed gesture navigates and React has to have
  // flushed that before the next assertion reads the page.
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function Probe() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <p data-testid="where">{pathname}</p>
      <p data-testid="plain">Vanlig text att dra i</p>
      <div data-swipe-ignore data-testid="chart">
        <svg data-testid="chart-line" />
      </div>
      <input type="range" data-testid="slider" aria-label="En skala" />
      <div data-testid="scroller" style={{ overflowX: "auto" }}>
        <span data-testid="scroller-child">brett</span>
      </div>
      <button type="button" data-testid="go-food" onClick={() => navigate("/food")}>
        Mat
      </button>
      <button type="button" data-testid="go-dashboard" onClick={() => navigate("/")}>
        Översikt
      </button>
    </div>
  );
}

function mount(at = "/dag") {
  render(
    <MemoryRouter initialEntries={[at]}>
      <SectionSwipe order={ORDER}>
        <Probe />
      </SectionSwipe>
    </MemoryRouter>,
  );

  // jsdom reports no layout, so the scroller has to be told it overflows.
  const scroller = screen.getByTestId("scroller");
  Object.defineProperty(scroller, "scrollWidth", { value: 800, configurable: true });
  Object.defineProperty(scroller, "clientWidth", { value: 300, configurable: true });

  return {
    track: screen.getByTestId("section-track"),
    where: () => screen.getByTestId("where").textContent,
  };
}

/** A whole gesture: down, a few moves, up. Returns the touchmove events. */
function swipe(
  from: Element,
  { x, y = 400, dx, dy = 0, ms = 200 }: { x: number; y?: number; dx: number; dy?: number; ms?: number },
): Event[] {
  touch(from, "touchstart", [{ clientX: x, clientY: y }], 0);

  const moves: Event[] = [];
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) {
    moves.push(
      touch(
        from,
        "touchmove",
        [{ clientX: x + (dx * step) / steps, clientY: y + (dy * step) / steps }],
        (ms * step) / steps,
      ),
    );
  }

  touch(from, "touchend", [], ms);
  return moves;
}

describe("swiping between sections", () => {
  it("moves to the next section when the release is past the threshold", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: 300, dx: -140 });

    expect(where()).toBe("/food");
  });

  it("moves to the previous one the other way", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: 60, dx: 140 });

    expect(where()).toBe("/");
  });

  /** A short, fast flick is a decision too, and 48 px is the floor under it. */
  it("completes on velocity without the distance", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: 300, dx: -60, ms: 40 });

    expect(where()).toBe("/food");
  });

  it("springs back when the release is short and slow", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: 300, dx: -40, ms: 600 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("translate3d(0, 0, 0)");
    expect(track.style.transition).toContain("200ms");
  });

  it("follows the finger while the gesture is in progress", () => {
    const { track } = mount("/dag");

    touch(track, "touchstart", [{ clientX: 300, clientY: 400 }], 0);
    touch(track, "touchmove", [{ clientX: 240, clientY: 402 }], 50);

    expect(track.style.transform).toBe("translate3d(-60px, 0, 0)");
    expect(track.style.transition).toBe("none");
  });

  /** Nothing lies beyond the last section, and the page says so before release. */
  it("resists past the ends and goes nowhere", () => {
    const { track, where } = mount("/framsteg");

    touch(track, "touchstart", [{ clientX: 300, clientY: 400 }], 0);
    touch(track, "touchmove", [{ clientX: 200, clientY: 400 }], 50);

    expect(track.style.transform).toBe("translate3d(-25px, 0, 0)");

    touch(track, "touchend", [], 60);
    expect(where()).toBe("/framsteg");
  });
});

describe("the touches the gesture leaves alone", () => {
  /** The operating system's own back gesture lives in these two strips. */
  it("ignores a touch that starts against the left edge", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: EDGE_GUARD_PX - 4, dx: 200 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  it("ignores a touch that starts against the right edge", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: WIDTH - EDGE_GUARD_PX + 4, dx: -200 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /** A drag across the trend line is reading the trend line. */
  it("ignores a touch that starts on the weight graph", () => {
    const { track, where } = mount("/dag");

    swipe(screen.getByTestId("chart-line"), { x: 200, dx: -200 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  it("ignores a touch that starts on a range input", () => {
    const { track, where } = mount("/dag");

    swipe(screen.getByTestId("slider"), { x: 200, dx: -200 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /** The general case the other two are instances of. */
  it("ignores a touch that starts inside something that scrolls sideways", () => {
    const { track, where } = mount("/dag");

    swipe(screen.getByTestId("scroller-child"), { x: 200, dx: -200 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /**
   * A page that scrolls is what a finger is usually doing, so horizontal has to
   * win clearly before the touch is claimed.
   */
  it("leaves a drag that is mostly vertical to the page", () => {
    const { track, where } = mount("/dag");

    swipe(track, { x: 300, dx: -100, dy: -180 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /** Once read as a scroll it stays one, rather than flipping halfway down. */
  it("does not claim a touch later that it declined at the start", () => {
    const { track, where } = mount("/dag");

    touch(track, "touchstart", [{ clientX: 300, clientY: 400 }], 0);
    touch(track, "touchmove", [{ clientX: 298, clientY: 320 }], 40);
    touch(track, "touchmove", [{ clientX: 120, clientY: 300 }], 90);
    touch(track, "touchend", [], 100);

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /** Two fingers is a pinch. */
  it("ignores a second finger", () => {
    const { track, where } = mount("/dag");

    touch(
      track,
      "touchstart",
      [
        { clientX: 200, clientY: 400 },
        { clientX: 260, clientY: 400 },
      ],
      0,
    );
    touch(track, "touchmove", [{ clientX: 60, clientY: 400 }], 50);
    touch(track, "touchend", [], 60);

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /** Desktop has a sidebar and no bar, so it has no order to move along. */
  it("does nothing above the phone breakpoint", () => {
    phone = false;
    const { track, where } = mount("/dag");

    swipe(track, { x: 300, dx: -200 });

    expect(where()).toBe("/dag");
    expect(track.style.transform).toBe("");
  });

  /** A claimed gesture stops the page scrolling under it; a declined one must not. */
  it("only takes the touch away from the page once it has claimed it", () => {
    const { track } = mount("/dag");

    const vertical = swipe(track, { x: 300, dx: -10, dy: -120 });
    expect(vertical.some((event) => event.defaultPrevented)).toBe(false);

    const horizontal = swipe(track, { x: 300, dx: -140 });
    expect(horizontal.some((event) => event.defaultPrevented)).toBe(true);
  });
});

describe("the slide", () => {
  /**
   * A tap in the navigation gets the same movement as a swipe, which is the
   * point of having a slide at all: one way of changing section, two ways of
   * asking for it.
   */
  it("runs on a tap in the navigation, in the direction of the order", () => {
    const { track, where } = mount("/dag");

    fireEvent.click(screen.getByTestId("go-food"));

    expect(where()).toBe("/food");
    expect(track.style.transform).toBe(`translate3d(${WIDTH}px, 0, 0)`);
    expect(track.style.transition).toBe("none");
  });

  it("comes from the other side going back", () => {
    const { track } = mount("/dag");

    fireEvent.click(screen.getByTestId("go-dashboard"));

    expect(track.style.transform).toBe(`translate3d(${-WIDTH}px, 0, 0)`);
  });

  /**
   * A completed swipe hands the offset over, so the incoming section starts
   * exactly where the finger left the outgoing one rather than a screen away.
   */
  it("picks up where the finger left off", () => {
    const { track } = mount("/dag");

    swipe(track, { x: 300, dx: -140 });

    expect(track.style.transform).toBe(`translate3d(${WIDTH - 140}px, 0, 0)`);
  });

  it("goes somewhere for a destination that has no place in the order", () => {
    expect(directionBetween(ORDER, "/dag", "/installningar")).toBe(1);
    expect(directionBetween(ORDER, "/framsteg", "/dag")).toBe(-1);
  });
});

describe("with reduced motion asked for", () => {
  /** The navigation is the feature. The movement is the decoration. */
  it("still changes section, and nothing moves", () => {
    reducedMotion = true;
    const { track, where } = mount("/dag");

    touch(track, "touchstart", [{ clientX: 300, clientY: 400 }], 0);
    touch(track, "touchmove", [{ clientX: 240, clientY: 400 }], 40);
    expect(track.style.transform).toBe("");

    touch(track, "touchmove", [{ clientX: 140, clientY: 400 }], 80);
    touch(track, "touchend", [], 90);

    expect(where()).toBe("/food");
    expect(track.style.transform).toBe("");
    expect(track.style.transition).toBe("");
  });

  it("does not slide on a tap either", () => {
    reducedMotion = true;
    const { track, where } = mount("/dag");

    fireEvent.click(screen.getByTestId("go-food"));

    expect(where()).toBe("/food");
    expect(track.style.transform).toBe("");
  });
});
