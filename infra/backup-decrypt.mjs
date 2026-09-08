/**
 * Decrypts a backup written by the app (D103).
 *
 *   node infra/backup-decrypt.mjs vikt-20260906T031700Z.dump.enc vikt.dump
 *
 * Reads `SECRET_KEY`, or the file named by `SECRET_KEY_FILE`, exactly as the
 * app does. The output is an ordinary `pg_dump -Fc` archive, so the restore is
 * the same `pg_restore` it has always been:
 *
 *   createdb -U vikt vikt_restore
 *   pg_restore -U vikt -d vikt_restore --no-owner vikt.dump
 *
 * ## Why this is a script and not a button
 *
 * Restoring is the one operation that destroys a live database by succeeding.
 * A button next to "run now" is four pixels from the thing you meant to press,
 * and an interface cannot ask "are you certain" in a way that survives being
 * asked twice a year. So the app writes backups and reads their status, and
 * putting one back is a command somebody types on the host.
 *
 * ## The format
 *
 *   "VIKTBK1" | 12-byte IV | AES-256-GCM ciphertext | 16-byte tag
 *
 * The tag is at the end and is checked before a single byte is written to the
 * output, so a truncated or altered backup fails loudly rather than restoring
 * most of a database. That is the property worth having here: a partial restore
 * that looks like it worked is far worse than an obvious failure.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createDecipheriv, hkdfSync } from "node:crypto";

const MAGIC = "VIKTBK1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT = Buffer.from("vikt.secrets.v1");
const USE = "vikt.backup.file";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write("Usage: backup-decrypt.mjs <file.dump.enc> <file.dump>\n");
  process.exit(2);
}

function secret() {
  const file = process.env.SECRET_KEY_FILE?.trim();
  if (file) {
    if (!existsSync(file)) {
      process.stderr.write(`SECRET_KEY_FILE points at ${file}, which does not exist.\n`);
      process.exit(1);
    }
    return readFileSync(file, "utf8").trim();
  }
  const inline = process.env.SECRET_KEY?.trim();
  if (!inline) {
    process.stderr.write("SECRET_KEY is not set, so this file cannot be read.\n");
    process.exit(1);
  }
  return inline;
}

const blob = readFileSync(input);
if (blob.subarray(0, MAGIC.length).toString() !== MAGIC) {
  process.stderr.write(`${input} is not a Vikt backup (missing the ${MAGIC} header).\n`);
  process.exit(1);
}

const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
const tag = blob.subarray(blob.length - TAG_BYTES);
const body = blob.subarray(MAGIC.length + IV_BYTES, blob.length - TAG_BYTES);

const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret(), "utf8"), SALT, USE, 32));
const decipher = createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);

let plain;
try {
  // `final()` is where the tag is verified, so nothing is written until the
  // whole file has been authenticated.
  plain = Buffer.concat([decipher.update(body), decipher.final()]);
} catch {
  process.stderr.write(
    "This file could not be decrypted. Either SECRET_KEY is not the key it was " +
      "written with, or the file has been altered or truncated.\n",
  );
  process.exit(1);
}

writeFileSync(output, plain);
process.stdout.write(`${output}: ${plain.length} bytes. Restore with pg_restore --no-owner.\n`);
