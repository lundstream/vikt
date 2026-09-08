/**
 * A v4 UUID for `client_uuid`.
 *
 * Not `crypto.randomUUID()` directly: that is only exposed in **secure
 * contexts**. Over plain HTTP on a LAN address — which is exactly how this app
 * gets tested from a phone before there is a certificate — it is `undefined`,
 * and every attempt to log anything throws. Production is HTTPS behind
 * Cloudflare, so the bug would only ever have shown up on the device it matters
 * most on.
 *
 * `crypto.getRandomValues` has no such restriction, so the fallback is still
 * cryptographically random. `client_uuid` carries a uniqueness guarantee the
 * offline queue depends on (CLAUDE.md §3), so `Math.random` is not good enough
 * and is not used.
 */
export function clientUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // Version 4, variant 10xx, per RFC 4122.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;

    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }

  // No CSPRNG at all. Guessing would silently risk collisions between devices,
  // and a collision here means one person's reading overwriting another entry.
  throw new Error(
    "This browser exposes no secure random source, so entries cannot be given a stable id.",
  );
}
