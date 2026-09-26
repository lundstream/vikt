import { PHOTO_MAX_BYTES, PHOTO_MAX_EDGE, PHOTO_QUALITY } from "shared";

/**
 * Getting a photograph small enough to send, before it is sent (D143).
 *
 * The phone's own file is three to eleven megabytes. What the model needs is
 * 1280 px on the long edge, which came out at 77 to 211 kB when this was
 * measured, so the resize is not a courtesy to the network — it is the
 * difference between a wait somebody will accept and one they will not.
 *
 * It also **strips EXIF**, and that is the part worth saying out loud. A phone
 * photograph carries the coordinates of the place it was taken, the time to the
 * second, and the model of the phone. None of that is anything to do with what
 * was for dinner, and none of it should leave the phone for a plate of food.
 * Re-encoding through a canvas drops every tag there is, because the canvas has
 * only pixels to start from.
 *
 * The one tag that matters is orientation, and it is applied **before** it is
 * dropped, so a photograph taken sideways arrives the way up it was taken
 * (D190). A phone stores the pixels as the sensor saw them and writes the turn
 * into EXIF; a canvas that drew them without it would send the model a label
 * on its side. `createImageBitmap` is asked to honour the tag, and this file
 * does not take that on trust: it reads the tag itself, asks the browser once
 * whether its decoder applies it (a two-pixel image turned a quarter), and
 * turns the canvas itself when it does not. `photo-orientation.test.ts` holds
 * the arithmetic against a rotated fixture; the real decoder is checked in a
 * browser (STATE.md, Phase 14).
 */

export type PreparedPhoto =
  /**
   * Base64 without a data URL prefix, which is what the endpoint takes, and
   * the same bytes as a blob, for a screen that shows the picture beside what
   * was read from it (D190). Held in memory while that screen is open; never
   * stored.
   */
  | { ok: true; base64: string; bytes: number; blob: Blob }
  | { ok: false; reason: "too_large" | "unreadable" };

/**
 * The resize arithmetic, on its own so it can be tested without a canvas.
 *
 * Never enlarges: a small photograph is already small, and scaling it up would
 * cost bytes to add nothing. Rounds rather than floors, and floors at one pixel,
 * so a pathological aspect ratio cannot produce a zero-width canvas.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A file from the camera, ready to post.
 *
 * Returns a discriminated result rather than throwing, because both failures
 * are things a person can act on and neither is an error in the sense of
 * something being broken: a picture that is still too big after the resize is
 * one to take again, and one that cannot be decoded is one the browser could
 * not read at all.
 */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  let bitmap: ImageBitmap;
  let orientation = 1;
  try {
    orientation = readJpegOrientation(new Uint8Array(await file.arrayBuffer()));
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  /**
   * Whether this canvas has to turn the picture itself: only when the tag says
   * it is turned and this browser's decoder did not already do it.
   */
  const turn = orientation !== 1 && !(await decoderAppliesOrientation()) ? orientation : 1;
  const upright = orientedSize(bitmap.width, bitmap.height, turn);
  const size = fitWithin(upright.width, upright.height);

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (context === null) {
    bitmap.close();
    return { ok: false, reason: "unreadable" };
  }

  const scale = size.width / upright.width;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  const [a, b, c, d, e, f] = orientationMatrix(turn, bitmap.width, bitmap.height);
  context.transform(a, b, c, d, e, f);
  context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
  // The decoded original is several megabytes of memory on a phone, and it has
  // nothing left to contribute once it is on the canvas.
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY),
  );
  if (blob === null) return { ok: false, reason: "unreadable" };

  /**
   * Checked here, on the re-encoded bytes, and again by the schema on the
   * server. The client check is the one that can say something useful — it
   * knows a photograph was just taken — and the server check is the one that
   * holds when the client is not this client.
   */
  if (blob.size > PHOTO_MAX_BYTES) return { ok: false, reason: "too_large" };

  return { ok: true, base64: await toBase64(blob), bytes: blob.size, blob };
}

/* ------------------------------------------------------------ orientation */

/**
 * The EXIF orientation of a JPEG, 1 to 8, or 1 when it has none.
 *
 * Read from the APP1 segment by hand: the tag is one short in IFD0 and a
 * library for it would be larger than this function. Anything that is not a
 * JPEG, or not the shape expected, is orientation 1, which draws the pixels as
 * stored: the wrong way up is recoverable by a person, a thrown error is not.
 */
export function readJpegOrientation(bytes: Uint8Array): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1]!;
    // Start of scan: the metadata is over.
    if (marker === 0xda) return 1;
    const length = view.getUint16(offset + 2);
    if (marker === 0xe1 && length >= 8) {
      const start = offset + 4;
      const header = String.fromCharCode(...bytes.slice(start, start + 4));
      if (header === "Exif") {
        const tiff = start + 6;
        const little = view.getUint16(tiff) === 0x4949;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        if (ifd + 2 > bytes.length) return 1;
        const entries = view.getUint16(ifd, little);
        for (let i = 0; i < entries; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > bytes.length) return 1;
          if (view.getUint16(entry, little) === 0x0112) {
            const value = view.getUint16(entry + 8, little);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
    }
    offset += 2 + length;
  }
  return 1;
}

/** The upright size of a picture stored `width` by `height` under `orientation`. */
export function orientedSize(
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/**
 * The canvas transform that draws a picture stored `width` by `height` upright,
 * as `[a, b, c, d, e, f]` for `transform()`. Orientation 1 is the identity.
 */
export function orientationMatrix(
  orientation: number,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, width, 0];
    case 3:
      return [-1, 0, 0, -1, width, height];
    case 4:
      return [1, 0, 0, -1, 0, height];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, height, 0];
    case 7:
      return [0, -1, -1, 0, height, width];
    case 8:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * Two pixels, side by side, tagged as turned a quarter (orientation 6).
 * Decoded upright they are one wide and two tall; decoded as stored they are
 * two wide and one tall. Which of those comes back is the answer.
 */
const ORIENTATION_PROBE =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDkJv8AXP8A7x/nRRRX29D+FH0RjW/iS9Wf/9k=";

let applies: Promise<boolean> | null = null;

/**
 * Whether this browser's decoder turns a picture by its EXIF tag, asked once.
 *
 * Every current browser does, and one that did not would send a sideways
 * label to a model that then reads it badly: the probe's sideways foil bag was
 * the worst of its three (D190). So the question is asked rather than assumed,
 * and the answer decides whether the canvas turns the picture itself. A
 * browser that cannot decode the probe at all is taken to apply it, which is
 * the modern default.
 */
export function decoderAppliesOrientation(): Promise<boolean> {
  applies ??= (async () => {
    try {
      const bytes = Uint8Array.from(atob(ORIENTATION_PROBE), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), {
        imageOrientation: "from-image",
      });
      const upright = bitmap.height > bitmap.width;
      bitmap.close();
      return upright;
    } catch {
      return true;
    }
  })();
  return applies;
}

/**
 * Bytes to base64, through the FileReader.
 *
 * `readAsDataURL` and then cut the prefix off, rather than building it from an
 * array buffer by hand: the hand-built version means a loop over several
 * hundred thousand bytes on the main thread of a phone, and this one is done by
 * the browser.
 */
async function toBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.readAsDataURL(blob);
  });

  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}
