/**
 * The few facts about a JPEG this app needs, read from the bytes (D190, D191).
 *
 * Shared because both ends need the same answers: the phone reads the EXIF
 * orientation to turn a photograph upright before it strips the tag, and the
 * server reads the size and the orientation again, and strips every metadata
 * segment, before it stores a meal's photo. A client that is not this client
 * does not get to store somebody's GPS coordinates.
 *
 * Markers only; nothing here decodes a pixel.
 */

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

type Segment = { marker: number; start: number; end: number };

/**
 * The header segments, in order, up to the start of the scan. Stops at the
 * first thing that is not a marker, which is how a truncated or foreign file
 * ends up with no segments rather than an exception.
 */
function segments(bytes: Uint8Array): { list: Segment[]; scanAt: number | null } {
  const list: Segment[] = [];
  if (!isJpeg(bytes)) return { list, scanAt: null };
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return { list, scanAt: null };
    const marker = bytes[offset + 1]!;
    // Padding bytes before a marker are allowed.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xda) return { list, scanAt: offset };
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return { list, scanAt: null };
    list.push({ marker, start: offset, end: offset + 2 + length });
    offset += 2 + length;
  }
  return { list, scanAt: null };
}

/** The EXIF orientation, 1 to 8, or 1 when there is none or it cannot be read. */
export function readJpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const segment of segments(bytes).list) {
    if (segment.marker !== 0xe1) continue;
    const start = segment.start + 4;
    if (start + 14 > segment.end) continue;
    const header = String.fromCharCode(...bytes.slice(start, start + 4));
    if (header !== "Exif") continue;
    const tiff = start + 6;
    const little = view.getUint16(tiff) === 0x4949;
    const ifd = tiff + view.getUint32(tiff + 4, little);
    if (ifd + 2 > segment.end) return 1;
    const entries = view.getUint16(ifd, little);
    for (let i = 0; i < entries; i += 1) {
      const entry = ifd + 2 + i * 12;
      if (entry + 12 > segment.end) return 1;
      if (view.getUint16(entry, little) === 0x0112) {
        const value = view.getUint16(entry + 8, little);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
    return 1;
  }
  return 1;
}

/** Width and height from the frame header, or null when there is none. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  for (const segment of segments(bytes).list) {
    const m = segment.marker;
    // SOF0 to SOF15, which are not DHT (C4), JPG (C8) or DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const at = segment.start + 5;
      if (at + 4 > segment.end) return null;
      const height = (bytes[at]! << 8) | bytes[at + 1]!;
      const width = (bytes[at + 2]! << 8) | bytes[at + 3]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  return null;
}

/**
 * The same JPEG without its metadata: every APP1 to APP15 segment (EXIF, XMP,
 * ICC, maker notes) and every comment removed, the frame and the scan copied
 * as they were. Null when the file is not a JPEG this can walk.
 *
 * APP0 (JFIF) stays: it says how to read the pixels and nothing about who
 * took them.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  const { list, scanAt } = segments(bytes);
  if (scanAt === null) return null;
  const kept = list.filter(
    (segment) => !((segment.marker >= 0xe1 && segment.marker <= 0xef) || segment.marker === 0xfe),
  );
  const size = 2 + kept.reduce((sum, s) => sum + (s.end - s.start), 0) + (bytes.length - scanAt);
  const out = new Uint8Array(size);
  out[0] = 0xff;
  out[1] = 0xd8;
  let at = 2;
  for (const segment of kept) {
    out.set(bytes.subarray(segment.start, segment.end), at);
    at += segment.end - segment.start;
  }
  out.set(bytes.subarray(scanAt), at);
  return out;
}

/** Whether any metadata segment is present: what the tests look for. */
export function hasJpegMetadata(bytes: Uint8Array): boolean {
  return segments(bytes).list.some(
    (segment) => (segment.marker >= 0xe1 && segment.marker <= 0xef) || segment.marker === 0xfe,
  );
}
