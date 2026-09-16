import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The page's declared picture size is the size of the picture (D178).
 *
 * The three phone pictures are made by hand and resized by
 * `scripts/landing-screens.mjs`, so their shape is whatever the mockup tool
 * exported that day. The `<img>` carries `width` and `height` so the browser
 * reserves the right box before the bytes arrive, which is the whole reason the
 * landing page measures **zero** cumulative layout shift.
 *
 * Those two numbers were written once, by hand, from a set that was 1419 x 2796.
 * The next set was 1839 x 3840, and nothing in the build would have said so:
 * the pictures would have been drawn into a box of the wrong height, the page
 * would have jumped as they loaded, and the only signal would have been a
 * Lighthouse score somebody re-measures every few weeks.
 *
 * So the size is read out of the files and compared with what the page claims.
 * Both halves come from disk; neither is a number typed into a test.
 *
 * ## And the transparency (D179)
 *
 * The sources are phones cut out of their background: every corner is empty and
 * the frame's edge is soft. The resize ran them through a headless page and
 * captured it, and a captured page is opaque unless Chrome is told otherwise,
 * so the delivered files were RGB with a white rectangle baked in behind a
 * black phone. On Natt that is invisible, which is exactly why it needs a test
 * rather than a look.
 */

const WEB = path.resolve(import.meta.dirname, "..");
const SCREENS = ["oversikt", "mat", "framsteg"] as const;

/** Width and height out of a PNG's IHDR, which is always its first chunk. */
function pngSize(file: string): { width: number; height: number } {
  const header = readFileSync(file).subarray(0, 24);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/** IHDR's colour type: 6 is RGBA, 4 is grey with alpha, 2 and 0 carry none. */
const pngColourType = (file: string) => readFileSync(file).readUInt8(25);

/** IHDR's interlace method. Anything but 0 changes how the rows below are laid out. */
const pngInterlace = (file: string) => readFileSync(file).readUInt8(28);

/**
 * The alpha of the pixel at 0,0.
 *
 * The scanlines are the concatenated IDAT chunks, inflated. Each row begins
 * with a filter byte, and for the **first** pixel of the first row every filter
 * predicts from pixels that do not exist, so all five reduce to the stored
 * value: no un-filtering is needed to read this one pixel. Depth is asserted at
 * eight bits below, which is what Chrome writes.
 */
function firstPixelAlpha(file: string): number {
  const bytes = readFileSync(file);
  const parts: Buffer[] = [];

  let at = 8; // past the signature
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") break;
    at += 12 + length;
  }

  const scanlines = inflateSync(Buffer.concat(parts));
  // filter byte, then R G B A of the first pixel.
  return scanlines.readUInt8(4);
}

describe("the landing page's phone pictures", () => {
  const source = readFileSync(path.join(WEB, "src/landing/Landing.tsx"), "utf8");

  /**
   * One pair for all three, because they are laid out as one row of equals:
   * three pictures of different shapes in one grid is a design decision, and
   * this test is where it would have to be made deliberately.
   */
  const declared = source.match(/width=\{(\d+)\}\s*\n\s*height=\{(\d+)\}/);

  it("declares a size at all", () => {
    expect(
      declared,
      "Landing.tsx no longer gives the phone pictures a width and height, which is layout shift",
    ).not.toBeNull();
  });

  for (const name of SCREENS) {
    it(`${name}.png is the shape the page reserves for it`, () => {
      const file = path.join(WEB, "public/screens", `${name}.png`);
      const actual = pngSize(file);
      const width = Number(declared![1]);
      const height = Number(declared![2]);

      expect(actual.width, `${name}.png is ${actual.width} px wide, the page says ${width}`).toBe(
        width,
      );
      /*
        One pixel of slack, and no more: the resize rounds the height off the
        source's own ratio, so an exact match would fail on a source whose
        aspect ratio lands between two whole pixels. Two would let a genuinely
        different shape through.
      */
      expect(
        Math.abs(actual.height - height),
        `${name}.png is ${actual.height} px tall, the page says ${height}. ` +
          "Run node scripts/landing-screens.mjs and update the img in Landing.tsx.",
      ).toBeLessThanOrEqual(1);
    });
  }

  /**
   * Delivered with their transparency, and empty in the corner.
   *
   * The corner is the strongest single check: these are cut-out phones, so 0,0
   * is outside the frame on every one of them. A file that had been flattened
   * would have the page's own background there instead, and on Natt nobody
   * would see it.
   */
  for (const name of SCREENS) {
    it(`${name}.png keeps its alpha channel`, () => {
      const file = path.join(WEB, "public/screens", `${name}.png`);

      expect(
        pngColourType(file),
        `${name}.png is colour type ${pngColourType(file)}; 6 is RGBA. ` +
          "Run node scripts/landing-screens.mjs, which keeps the alpha.",
      ).toBe(6);
      expect(pngInterlace(file), "an interlaced PNG is read differently").toBe(0);
      expect(readFileSync(file).readUInt8(24), "eight bits a channel").toBe(8);

      expect(
        firstPixelAlpha(file),
        `${name}.png has something painted in its top left corner, so it was flattened`,
      ).toBe(0);
    });
  }

  /** All three the same shape, which the single declared pair assumes. */
  it("are all the same shape", () => {
    const shapes = SCREENS.map((name) => {
      const { width, height } = pngSize(path.join(WEB, "public/screens", `${name}.png`));
      return `${width}x${height}`;
    });
    expect(new Set(shapes).size, `the three pictures are ${shapes.join(", ")}`).toBe(1);
  });
});
