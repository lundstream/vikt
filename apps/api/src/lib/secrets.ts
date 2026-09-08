import { existsSync, readFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption for secrets the app stores rather than reads (D102).
 *
 * ## What this is for, and what it is not
 *
 * Since mail settings moved into the database, the SMTP password is a value the
 * app *keeps* rather than a value the operator supplies at boot. This encrypts
 * it at rest with a key that stays in the environment.
 *
 * **What that buys, exactly:**
 *
 *  - **One secret in the environment instead of four.** `SECRET_KEY` replaces
 *    `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` and the rest as the thing an operator
 *    has to get into the container.
 *  - **Editing and testing from the interface.** Changing a mail server stops
 *    being an edit to a file on the host followed by a restart.
 *  - **A database dump without the mail password in clear.** `pg_dump` output
 *    goes to a backup destination and is read by whoever can read that
 *    destination, and D96's backup script does not encrypt. This is the
 *    difference between a leaked dump costing the mail account and not.
 *
 * **What it does not buy, stated plainly because it is the thing that gets
 * overclaimed:** this does not make the install secretless. `SECRET_KEY` is a
 * secret in the environment, exactly like `SESSION_SECRET` and the database
 * password, and anyone who can read the environment of the running process can
 * decrypt everything this protects. It defends a dump at rest and nothing else.
 * An attacker with the environment has the key; an attacker with the database
 * has ciphertext.
 *
 * ## The key
 *
 * `SECRET_KEY`, or a file named by `SECRET_KEY_FILE` for Docker secrets, which
 * is the form the compose file uses. The file is read once at startup, and
 * trailing whitespace is stripped because `echo` into a secrets file adds a
 * newline and that is not a key change anybody intends.
 *
 * The value is put through HKDF rather than used directly, so any length of
 * input produces a 32-byte key and two different uses of the same secret cannot
 * produce the same key. The `info` string is the use: a second encrypted column
 * added later takes its own, and neither can decrypt the other's ciphertext.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Fixed and public. HKDF's salt is a domain separator, not a secret. */
const SALT = Buffer.from("vikt.secrets.v1");

export class MissingSecretKey extends Error {
  constructor() {
    super(
      "SECRET_KEY (or SECRET_KEY_FILE) is not set, so stored secrets cannot be read or written.",
    );
    this.name = "MissingSecretKey";
  }
}

/**
 * The raw secret, from the environment or from the file it names.
 *
 * `SECRET_KEY_FILE` wins when both are set: a deployment that mounts a Docker
 * secret and also has a stale variable in its environment means the file, and
 * silently preferring the variable would decrypt nothing while looking fine.
 */
export function readSecretKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = env.SECRET_KEY_FILE?.trim();
  if (file) {
    if (!existsSync(file)) return null;
    const contents = readFileSync(file, "utf8").trim();
    return contents === "" ? null : contents;
  }

  const inline = env.SECRET_KEY?.trim();
  return inline ? inline : null;
}

/** Whether stored secrets can be read at all. */
export function secretsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return readSecretKey(env) !== null;
}

function keyFor(use: string, env: NodeJS.ProcessEnv): Buffer {
  const secret = readSecretKey(env);
  if (secret === null) throw new MissingSecretKey();
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, use, 32));
}

/**
 * Encrypts one value, returning a self-describing string.
 *
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version prefix is there so a
 * future algorithm change can be told apart from a corrupt value rather than
 * failing as one, and so a column can hold both during a migration.
 */
export function encryptSecret(
  plaintext: string,
  use: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFor(use, env), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ["v1", iv.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(
    ".",
  );
}

/**
 * Decrypts a value written by `encryptSecret`.
 *
 * Returns `null` for anything it cannot read: a wrong key, a truncated value, a
 * tampered one. The caller's job is then to say "the stored password cannot be
 * read" rather than to send mail with an empty password and report an auth
 * failure, which is the same symptom with a much worse explanation.
 */
export function decryptSecret(
  stored: string,
  use: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;

  try {
    const iv = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const body = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGORITHM, keyFor(use, env), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Includes the GCM tag check failing, which is the case that matters: a
    // value that has been altered is refused rather than half-decrypted.
    return null;
  }
}

/** The `use` strings in play. One per encrypted column, never reused. */
export const SECRET_USES = {
  mailPassword: "vikt.mail.password",
  backupDestination: "vikt.backup.destination",
} as const;
