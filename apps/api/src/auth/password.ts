import { hash, verify, type Options } from "@node-rs/argon2";

/**
 * argon2id password hashing (CLAUDE.md §2).
 *
 * Parameters are the OWASP baseline: 19 MiB, 2 iterations, 1 lane. Bumping
 * them later is safe — the parameters are encoded in the stored PHC string,
 * so old hashes keep verifying and are rehashed on next successful login.
 */

/**
 * `Algorithm.Argon2id`. The enum is declared `const` in the napi-rs typings,
 * which `verbatimModuleSyntax` forbids importing, so the value is spelled out.
 * It is also the library default; being explicit keeps a security parameter
 * from depending on someone else's default not changing.
 */
const ARGON2ID = 2;

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} satisfies Options;

export function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, OPTIONS);
}

export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(digest, plaintext, OPTIONS);
  } catch {
    // A malformed stored hash must read as "wrong password", not as a 500.
    return false;
  }
}
