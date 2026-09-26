import { createHash } from "node:crypto";

/**
 * A client uuid derived from another and a position, the same every time.
 *
 * Logging a meal writes one food row per ingredient, and every food row needs
 * a `client_uuid` for the replay rule (§3). The client names the logging once;
 * each row's key is derived from that name and the row's position, so a replay
 * of the same logging lands on the same rows and a second logging of the same
 * meal, with a new name, writes new ones (D186). Asking the client for one key
 * per row, as the template did, tied the request to a row count the client
 * could get wrong and the server then refused.
 *
 * The shape of an RFC 4122 name-based uuid (version 5, SHA-1), so it passes
 * every uuid check a hand-made one would.
 */
export function deriveUuid(base: string, position: number): string {
  const hash = createHash("sha1").update(`${base.toLowerCase()}:${position}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
