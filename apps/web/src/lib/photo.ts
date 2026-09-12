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
 * The one tag that matters is orientation, and it is applied rather than
 * dropped: `createImageBitmap` is asked to honour it, so a photograph taken
 * sideways arrives the way up it was taken.
 */

export type PreparedPhoto =
  /** Base64 without a data URL prefix, which is what the endpoint takes. */
  | { ok: true; base64: string; bytes: number }
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
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const size = fitWithin(bitmap.width, bitmap.height);

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");
  if (context === null) {
    bitmap.close();
    return { ok: false, reason: "unreadable" };
  }

  context.drawImage(bitmap, 0, 0, size.width, size.height);
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

  return { ok: true, base64: await toBase64(blob), bytes: blob.size };
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
