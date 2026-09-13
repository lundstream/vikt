import { deflateSync } from "node:zlib";

/**
 * A small picture with known contents, for asking a model whether it can see.
 *
 * The reason this exists at all is the probe's first finding: **a capability
 * flag is not a test.** Ollama reports a `vision` capability for four of the
 * models on this workstation, and one of them accepts an image, answers
 * fluently, and says nothing was attached — twice, once to this image and once
 * to a photograph of a plate (`docs/measurements.md`). A flag describes a build;
 * this asks the tag in front of you.
 *
 * Generated rather than committed as a file, and generated rather than taken
 * from the internet, for one reason each: a binary in the repository is a thing
 * nobody can review in a diff, and a stock image is a picture a model may well
 * have been trained on, which is the one thing that would make this test lie.
 *
 * Pure Node — a deflate stream, a CRC and three chunks — because a PNG encoder
 * is about eighty lines and a dependency that draws pictures is not worth
 * carrying for one 12 kB image nobody looks at.
 */

/** A red circle, a blue square, the word VIKT. 320 by 240. */
export function selfTestImage(): Buffer {
  const width = 320;
  const height = 240;

  return png(width, height, (set) => {
    const red = [220, 40, 40] as const;
    const blue = [40, 70, 200] as const;
    const black = [20, 20, 20] as const;

    for (let y = 60; y < 160; y += 1) {
      for (let x = 30; x < 130; x += 1) {
        if ((x - 80) ** 2 + (y - 110) ** 2 < 50 * 50) set(x, y, red);
      }
    }

    for (let y = 70; y < 150; y += 1) for (let x = 180; x < 260; x += 1) set(x, y, blue);

    const word = "VIKT";
    for (let index = 0; index < word.length; index += 1) {
      const glyph = GLYPHS[word[index] ?? ""] ?? [];
      for (let row = 0; row < glyph.length; row += 1) {
        const bits = glyph[row] ?? "";
        for (let column = 0; column < 5; column += 1) {
          if (bits[column] !== "1") continue;
          for (let dy = 0; dy < 6; dy += 1) {
            for (let dx = 0; dx < 6; dx += 1) {
              set(70 + index * 42 + column * 6 + dx, 180 + row * 6 + dy, black);
            }
          }
        }
      }
    }
  });
}

/** What to ask about it. Short, because a long answer is harder to judge. */
export const SELF_TEST_PROMPT =
  "Vad finns i bilden? Räkna upp former, färger och eventuell text. Svara kort.";

/**
 * Words a model that looked will use, grouped so that saying the same thing
 * twice does not count twice.
 *
 * Deliberately generous about wording and strict about the count. A model may
 * say "kvadrat", "fyrkant" or "ruta" and be equally right; what it cannot do,
 * without having looked, is name two of these three things.
 */
const SEEN = [
  ["röd", "rött", "red"],
  ["cirkel", "rund", "circle"],
  ["blå", "blått", "blue"],
  ["fyrkant", "kvadrat", "ruta", "square", "rektangel"],
  ["vikt"],
] as const;

/**
 * Phrases that mean the model is answering about nothing.
 *
 * Checked as well as the count, so the log can say *which* failure it was: "it
 * denied receiving an image" and "it described the wrong thing" call for
 * different next steps, and only the second is worth arguing with.
 */
const DENIALS = [
  "ingen bild",
  "inte bifogat",
  "inte någon bild",
  "kan inte se",
  "no image",
  "cannot see",
  "don't see",
];

export type SelfTestVerdict = { sees: boolean; matched: number; denied: boolean };

/**
 * Whether an answer is the answer of something that looked.
 *
 * Two of the five groups, which no model reaches by guessing: "a red circle and
 * a blue square" is not what anybody says about an image they did not receive,
 * and the model that fails this in practice says so in as many words.
 */
export function readSelfTest(answer: string): SelfTestVerdict {
  const text = answer.toLowerCase();
  const denied = DENIALS.some((phrase) => text.includes(phrase));
  const matched = SEEN.filter((group) => group.some((word) => text.includes(word))).length;

  return { sees: !denied && matched >= 2, matched, denied };
}

/* ------------------------------------------------------------ the encoder */

/** A minimal PNG: one IHDR, one IDAT, one IEND, no filtering. */
function png(
  width: number,
  height: number,
  draw: (set: (x: number, y: number, colour: readonly [number, number, number]) => void) => void,
): Buffer {
  const pixels = Buffer.alloc(width * height * 3, 255);
  draw((x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 3;
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
  });

  // One filter byte per scanline, filter 0 (none).
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    pixels.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const payload = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload) >>> 0);
  return Buffer.concat([length, payload, crc]);
}

let table: Int32Array | null = null;
function crc32(buffer: Buffer): number {
  if (table === null) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  return crc ^ -1;
}

/** Five-by-seven glyphs, enough to write one word. */
const GLYPHS: Record<string, string[]> = {
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};
