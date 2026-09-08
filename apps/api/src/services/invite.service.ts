import type { Db } from "../db/index.js";
import { newInviteCode } from "../auth/tokens.js";
import { insertInvite } from "../repositories/invites.repo.js";

/**
 * Minting an invite is an operator action run from the CLI, so it has no
 * session and no `userId` to scope to. `createdBy` is optional and only exists
 * for the phase-9 case where an existing member invites someone. This is an
 * allowlisted exception to the userId-first rule — see services/README.md.
 */
export async function mintInvite(
  db: Db,
  options: { createdBy?: string | null; expiresInDays?: number | null } = {},
): Promise<{ code: string; expiresAt: Date | null }> {
  const expiresAt =
    options.expiresInDays == null
      ? null
      : new Date(Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000);

  const row = await insertInvite(db, {
    code: newInviteCode(),
    createdBy: options.createdBy ?? null,
    expiresAt,
  });

  return { code: row.code, expiresAt: row.expiresAt };
}
