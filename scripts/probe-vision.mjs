/**
 * Does any model on this workstation actually look at an image?
 *
 * The question before any photo feature exists, and the reason it is a script
 * rather than a paragraph: Ollama reports a `vision` capability for four of the
 * models here, and a capability flag is a claim about a build, not evidence that
 * a particular tag on a particular box will do the thing. This project has been
 * caught by exactly that shape twice — an SMB client whose tests never reached
 * authentication, an S3 suite that had never run at all.
 *
 * Two modes:
 *
 *   node scripts/probe-vision.mjs <photo.jpg> [model ...]
 *     Posts a real photograph and prints what came back, with the time it took.
 *     This is the one that matters: a plate, photographed by somebody, because
 *     a stock image is a picture a model may have seen in training.
 *
 *   node scripts/probe-vision.mjs --selftest [model ...]
 *     Generates a small PNG with shapes and a word in it and asks what is in
 *     it. This cannot tell you whether a model can read a plate. It tells you
 *     whether the `images` field reaches the model at all, which is worth
 *     separating: "ignored the image" and "saw it and guessed badly" need
 *     different answers, and only one of them is the model's fault.
 *
 * Reads `OLLAMA_URL` and `LLM_VISION_MODEL` from the API's `.env` when they are
 * there, so it probes the host this installation actually uses.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The API's `.env`, read the same way the server reads it. */
function envFile() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return {};

  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

const env = { ...envFile(), ...process.env };
const host = (env.OLLAMA_URL ?? "").replace(/\/+$/, "");

if (host === "") {
  console.error("No OLLAMA_URL. Nothing to probe.");
  process.exit(1);
}

const args = process.argv.slice(2);
const selftest = args[0] === "--selftest";
const source = selftest ? null : args[0];
const models =
  args.slice(1).length > 0
    ? args.slice(1)
    : [env.LLM_VISION_MODEL, "qwen3.6:27b", "gemma4:e4b", "qwen3-vl"].filter(
        (name) => typeof name === "string" && name !== "",
      );

/* ------------------------------------------------------------ the self-test */

/** A minimal PNG encoder: enough for three shapes and a word, in pure Node. */
function png(width, height, draw) {
  const pixels = Buffer.alloc(width * height * 3, 255);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = (y * width + x) * 3;
    pixels[at] = r;
    pixels[at + 1] = g;
    pixels[at + 2] = b;
  };
  draw(set);

  // One filter byte per scanline, filter 0 (none).
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    pixels.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }

  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const payload = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(payload) >>> 0);
    return Buffer.concat([length, payload, crc]);
  };

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

let table = null;
function crc32(buffer) {
  if (table === null) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return crc ^ -1;
}

/** Five-by-seven glyphs, enough to write one word. */
const GLYPHS = {
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

function selftestImage() {
  const width = 320;
  const height = 240;

  return png(width, height, (set) => {
    const red = [220, 40, 40];
    const blue = [40, 70, 200];
    const black = [20, 20, 20];

    // A filled circle on the left.
    for (let y = 60; y < 160; y += 1) {
      for (let x = 30; x < 130; x += 1) {
        if ((x - 80) ** 2 + (y - 110) ** 2 < 50 * 50) set(x, y, red);
      }
    }

    // A filled square on the right.
    for (let y = 70; y < 150; y += 1) for (let x = 180; x < 260; x += 1) set(x, y, blue);

    // The word VIKT along the bottom, six pixels per cell.
    const word = "VIKT";
    for (let index = 0; index < word.length; index += 1) {
      const glyph = GLYPHS[word[index]];
      for (let row = 0; row < glyph.length; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          if (glyph[row][column] !== "1") continue;
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

/* ----------------------------------------------------------------- the ask */

const image = selftest ? selftestImage() : readFileSync(source);
const prompt = selftest
  ? "Vad finns i bilden? Räkna upp former, färger och eventuell text. Svara kort."
  : "Vad ligger på tallriken? Räkna upp maten du ser, en per rad, med ungefärlig mängd. Svara kort, på svenska.";

if (selftest) {
  const out = path.join(root, "scripts", ".probe-selftest.png");
  writeFileSync(out, image);
  console.log(`self-test image written to ${out} (${image.length} bytes)`);
}

console.log(`host: ${host}`);
console.log(`image: ${selftest ? "generated PNG" : source} (${Math.round(image.length / 1024)} kB)`);
console.log(`models: ${models.join(", ")}\n`);

for (const model of models) {
  const started = Date.now();
  try {
    const response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [{ role: "user", content: prompt, images: [image.toString("base64")] }],
      }),
      signal: AbortSignal.timeout(180_000),
    });

    const ms = Date.now() - started;

    if (!response.ok) {
      console.log(`${model}: HTTP ${response.status} after ${ms} ms`);
      console.log(`  ${(await response.text()).slice(0, 300)}\n`);
      continue;
    }

    const body = await response.json();
    const text = (body.message?.content ?? "").trim();
    console.log(`${model}: ${ms} ms`);
    console.log(text === "" ? "  (empty answer)" : text.split("\n").map((line) => `  ${line}`).join("\n"));
    console.log("");
  } catch (error) {
    console.log(`${model}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}\n`);
  }
}
