import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { orientationMatrix, orientedSize, readJpegOrientation } from "../src/lib/photo.js";

/**
 * A phone's sideways JPEG reaches the model upright (D190).
 *
 * The fixtures are 64 by 32 as stored, red on the left and blue on the right,
 * tagged with an EXIF orientation. Upright, `rotated-6.jpg` is 32 by 64 with
 * red on top, which is what a phone held in portrait writes. The decoder is a
 * browser's and jsdom has none, so what is held here is the part this app
 * owns: reading the tag, the upright size, and the turn the canvas makes when
 * the decoder did not. The real decoder is checked in a browser.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(here, "fixtures", name)));

/** Where a stored point lands under a canvas transform. */
function apply(matrix: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = matrix as [number, number, number, number, number, number];
  return [a * x + c * y + e, b * x + d * y + f];
}

describe("reading the orientation", () => {
  it("reads the tag a rotated fixture carries", () => {
    expect(readJpegOrientation(fixture("rotated-6.jpg"))).toBe(6);
    expect(readJpegOrientation(fixture("rotated-3.jpg"))).toBe(3);
  });

  it("is 1 for anything without one, rather than throwing", () => {
    expect(readJpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array(0))).toBe(1);
  });
});

describe("turning the canvas", () => {
  it("swaps the sides for a quarter turn and keeps them for a half", () => {
    expect(orientedSize(64, 32, 6)).toEqual({ width: 32, height: 64 });
    expect(orientedSize(64, 32, 8)).toEqual({ width: 32, height: 64 });
    expect(orientedSize(64, 32, 3)).toEqual({ width: 64, height: 32 });
    expect(orientedSize(64, 32, 1)).toEqual({ width: 64, height: 32 });
  });

  it("puts the stored left edge on top for orientation 6, as a portrait photo reads", () => {
    const matrix = orientationMatrix(6, 64, 32);
    // A red pixel near the stored left edge lands near the top.
    const [, redY] = apply(matrix, 4, 16);
    const [, blueY] = apply(matrix, 60, 16);
    expect(redY).toBeLessThan(32);
    expect(blueY).toBeGreaterThan(32);
  });

  it("turns orientation 3 by a half, so the stored left edge ends on the right", () => {
    const [redX] = apply(orientationMatrix(3, 64, 32), 4, 16);
    expect(redX).toBeGreaterThan(32);
  });

  it("maps every stored corner inside the upright picture, for all eight", () => {
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const size = orientedSize(64, 32, orientation);
      const matrix = orientationMatrix(orientation, 64, 32);
      for (const [x, y] of [
        [0, 0],
        [64, 0],
        [0, 32],
        [64, 32],
      ] as const) {
        const [ux, uy] = apply(matrix, x, y);
        expect(ux, `orientation ${orientation}`).toBeGreaterThanOrEqual(0);
        expect(ux, `orientation ${orientation}`).toBeLessThanOrEqual(size.width);
        expect(uy, `orientation ${orientation}`).toBeGreaterThanOrEqual(0);
        expect(uy, `orientation ${orientation}`).toBeLessThanOrEqual(size.height);
      }
    }
  });
});
