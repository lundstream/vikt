import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Session tokens and invite codes.
 *
 * The plaintext session token only ever exists in the cookie. What lands in
 * `sessions.token_hash` is a SHA-256 of it, so a database dump does not hand
 * anyone a set of live sessions. SHA-256 rather than argon2 is deliberate:
 * the token is 256 bits of CSPRNG output, so there is nothing to brute-force
 * and this runs on every single request.
 */

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison for hex digests of equal length. */
export function tokenHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Invite codes are read off a screen and typed on a phone, so the alphabet
 * drops the characters that get mistyped: I, O, 0, 1, U.
 */
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTVWXYZ23456789";
const INVITE_LENGTH = 16;

export function newInviteCode(): string {
  // 248 is the largest multiple of the alphabet length under 256; rejecting
  // bytes above it keeps every character equally likely.
  const ceiling = 256 - (256 % INVITE_ALPHABET.length);
  let code = "";
  while (code.length < INVITE_LENGTH) {
    for (const byte of randomBytes(INVITE_LENGTH)) {
      if (byte >= ceiling) continue;
      code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
      if (code.length === INVITE_LENGTH) break;
    }
  }
  return code;
}

/** `ABCD-EFGH-JKLM-NPQR`, for reading aloud. Normalised back on submit. */
export function formatInviteCode(code: string): string {
  return (code.match(/.{1,4}/g) ?? [code]).join("-");
}
