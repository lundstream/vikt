import { createDecipheriv, hkdfSync } from "node:crypto";

/**
 * The app's encrypted backup file, in one place (D103, D168).
 *
 *   "VIKTBK1" | 12-byte IV | AES-256-GCM ciphertext of pg_dump -Fc | 16-byte tag
 *
 * `backup.service.ts` writes it, the restore check reads it, and
 * `infra/backup-decrypt.mjs` reads it on a host with nothing but Node. The
 * script cannot import this file, so `backup.test.ts` checks that both hold the
 * same constants; everything inside the API uses these.
 */

export const BACKUP_MAGIC = "VIKTBK1";
export const BACKUP_IV_BYTES = 12;
export const BACKUP_TAG_BYTES = 16;

/** Its own use string, so a backup key cannot read the mail password. */
export const BACKUP_FILE_USE = "vikt.backup.file";
export const BACKUP_FILE_SALT = Buffer.from("vikt.secrets.v1");

export function backupKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), BACKUP_FILE_SALT, BACKUP_FILE_USE, 32),
  );
}

export type DecryptedBackup =
  | { ok: true; archive: Buffer }
  | { ok: false; reason: "not_a_backup" | "cannot_decrypt" };

/**
 * The `pg_dump -Fc` archive inside a backup, or why there is none.
 *
 * The tag is verified in `final()`, before anything is returned, so a truncated
 * or altered file, or a file written under a different `SECRET_KEY`, gives
 * nothing at all rather than most of a database.
 */
export function decryptBackup(blob: Buffer, secret: string): DecryptedBackup {
  const header = BACKUP_MAGIC.length + BACKUP_IV_BYTES;
  if (blob.length < header + BACKUP_TAG_BYTES) return { ok: false, reason: "not_a_backup" };
  if (blob.subarray(0, BACKUP_MAGIC.length).toString() !== BACKUP_MAGIC) {
    return { ok: false, reason: "not_a_backup" };
  }

  const iv = blob.subarray(BACKUP_MAGIC.length, header);
  const tag = blob.subarray(blob.length - BACKUP_TAG_BYTES);
  const body = blob.subarray(header, blob.length - BACKUP_TAG_BYTES);

  try {
    const decipher = createDecipheriv("aes-256-gcm", backupKey(secret), iv);
    decipher.setAuthTag(tag);
    return { ok: true, archive: Buffer.concat([decipher.update(body), decipher.final()]) };
  } catch {
    return { ok: false, reason: "cannot_decrypt" };
  }
}
