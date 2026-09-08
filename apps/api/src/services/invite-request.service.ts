import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { inviteRequests } from "../db/schema.js";
import { queueMail } from "../mail/queue.js";
import { inviteApprovedMail, inviteRequestedMail } from "../mail/templates.js";
import type { Env } from "../env.js";
import { mintInvite } from "./invite.service.js";
import { linkTo } from "../lib/links.js";

/**
 * Asking for a way in (D89).
 *
 * Registration is invite-only and has been since phase 0, which until now meant
 * the only way to get an account was to know the owner. The landing page adds a
 * form; this is what stands behind it.
 *
 * It stores as little as it can. An address, a name, an optional line about
 * why, and when — nothing about the browser, nothing derived from the address.
 * The name is there because the owner reads these one at a time and decides by
 * hand, and an address on its own is not much to decide on (D112). A
 * rejected request is **deleted** rather than marked rejected, because a record
 * of someone the owner turned down is personal data being kept for no purpose
 * anyone could name.
 */

export type RequestOutcome = "queued" | "already_pending";

/**
 * Records a request and queues its receipt.
 *
 * Returns the same shape for a repeat as for a new one, and the route says the
 * same thing either way: whether an address has already asked is not something
 * an anonymous caller gets to learn, for the same reason the reset endpoint
 * does not disclose whether an account exists.
 */
export async function requestInvite(
  db: Db,
  email: string,
  name: string | null,
  reason: string | null,
): Promise<RequestOutcome> {
  const address = email.trim();

  const inserted = await db
    .insert(inviteRequests)
    .values({ email: address, name, reason, status: "pending" })
    // Asking twice is one request. The unique index is on the lowercased
    // address, so casing cannot make a second row either.
    .onConflictDoNothing()
    .returning({ id: inviteRequests.id });

  if (inserted.length === 0) return "already_pending";

  await queueMail(db, address, inviteRequestedMail());
  return "queued";
}

export async function listInviteRequests(db: Db) {
  return db.select().from(inviteRequests).orderBy(desc(inviteRequests.createdAt)).limit(200);
}

export type ApprovalResult =
  | { ok: true; code: string; emailed: boolean }
  | { ok: false; reason: "not_found" };

/**
 * Approving: mint a code, keep the address and the date, queue the mail.
 *
 * The code is stored on the row so the admin view can show it again — which is
 * the whole fallback when mail is unconfigured. `emailed` says which happened,
 * so the screen can either say "sent" or show the code for the owner to pass on
 * by hand. An approval that silently did neither is the failure this avoids.
 */
export async function approveInviteRequest(
  db: Db,
  env: Env,
  id: string,
  adminUserId: string,
  mailEnabled: boolean,
): Promise<ApprovalResult> {
  const [row] = await db
    .select()
    .from(inviteRequests)
    .where(eq(inviteRequests.id, id))
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };

  // The same path the CLI uses (§6 phase 0), not a parallel one: a code minted
  // here has to be indistinguishable from one minted by hand.
  const { code } = await mintInvite(db, { createdBy: adminUserId });

  await db
    .update(inviteRequests)
    .set({ status: "approved", decidedAt: new Date(), inviteCode: code })
    .where(eq(inviteRequests.id, id));

  if (!mailEnabled) return { ok: true, code, emailed: false };

  const link = linkTo(env, "/app/register", { kod: code });
  await queueMail(db, row.email, inviteApprovedMail({ code, link }));

  return { ok: true, code, emailed: true };
}

/**
 * Rejecting: delete the row, send nothing.
 *
 * No mail, because a rejection notice is a message nobody asked for from an
 * address they cannot reply to. No row, because there is no reason to keep it.
 */
export async function rejectInviteRequest(db: Db, id: string): Promise<boolean> {
  const gone = await db
    .delete(inviteRequests)
    .where(eq(inviteRequests.id, id))
    .returning({ id: inviteRequests.id });
  return gone.length > 0;
}

/** An approved row, once the owner is done with it. */
export async function deleteInviteRequest(db: Db, id: string): Promise<boolean> {
  const gone = await db
    .delete(inviteRequests)
    .where(eq(inviteRequests.id, id))
    .returning({ id: inviteRequests.id });
  return gone.length > 0;
}

