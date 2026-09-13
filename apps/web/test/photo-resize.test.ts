import { describe, expect, it } from "vitest";
import { PHOTO_MAX_EDGE } from "shared";
import { fitWithin } from "../src/lib/photo.js";

/**
 * The arithmetic of the resize (D143).
 *
 * Separated from the canvas work so it can be tested at all: jsdom has no
 * canvas and no `createImageBitmap`, and a rule that only exists inside a
 * browser API is a rule nothing checks. What is worth checking is the part that
 * decides how big the photograph the model gets actually is, because that is
 * what the measured 10 to 20 second wait was measured at.
 */

describe("fitting a photograph inside the long edge", () => {
  it("scales a landscape photograph by its width", () => {
    // What a phone actually produces: 4032 by 3024.
    expect(fitWithin(4032, 3024)).toEqual({ width: 1280, height: 960 });
  });

  it("scales a portrait photograph by its height", () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 960, height: 1280 });
  });

  /**
   * Never enlarges. A small photograph is already small, and scaling it up
   * would spend bytes and a longer wait to add no pixels that were ever there.
   */
  it("leaves anything already small alone", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(PHOTO_MAX_EDGE, 720)).toEqual({ width: PHOTO_MAX_EDGE, height: 720 });
  });

  /** A canvas of zero width draws nothing and encodes to nothing. */
  it("never rounds a dimension down to zero", () => {
    expect(fitWithin(20000, 3).height).toBeGreaterThanOrEqual(1);
  });
});
