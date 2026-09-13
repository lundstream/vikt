import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { adminLog, announcementSeen, announcements, profiles, users } from "../db/schema.js";
import { queueMail } from "../mail/queue.js";
import { markdownToHtml, markdownToText } from "shared";
import { ANNOUNCEMENT_STYLE, escapeHtml, shell } from "../mail/templates.js";

/**
 * Announcements (D108).
 *
 * Installation-wide rather than per user, so these functions do not take
 * `userId` first and are named in the isolation rule's `allowUnscoped` with that
 * reasoning. The two that *are* per user — what a person should see, and marking
 * one seen — take it first like everything else.
 */

export type Kind = "maintenance" | "news" | "notice";

export type Announcement = {
  id: string;
  kind: Kind;
  startsAt: string | null;
  endsAt: string | null;
  leadMinutes: number;
  title: string;
  body: string | null;
  published: boolean;
  sendMail: boolean;
  mailedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Actor = { id: string; email: string };

function view(row: typeof announcements.$inferSelect): Announcement {
  return {
    id: row.id,
    kind: row.kind,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    leadMinutes: row.leadMinutes,
    title: row.title,
    body: row.body,
    published: row.published,
    sendMail: row.sendMail,
    mailedAt: row.mailedAt?.toISOString() ?? null,
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/* ------------------------------------------------------------ the admin side */

export async function listAnnouncements(db: Db): Promise<Announcement[]> {
  const rows = await db.select().from(announcements).orderBy(desc(announcements.createdAt));
  return rows.map(view);
}

export type AnnouncementInput = {
  kind: Kind;
  startsAt: string | null;
  endsAt: string | null;
  leadMinutes: number;
  title: string;
  body: string | null;
  published: boolean;
  sendMail: boolean;
};

export async function createAnnouncement(
  db: Db,
  actor: Actor,
  input: AnnouncementInput,
): Promise<Announcement> {
  const [row] = await db
    .insert(announcements)
    .values({
      kind: input.kind,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      leadMinutes: input.leadMinutes,
      title: input.title.trim(),
      body: input.body?.trim() || null,
      published: input.published,
      sendMail: input.sendMail,
      createdByEmail: actor.email,
    })
    .returning();

  await record(db, actor, "announcement.create", row!.id, input.title);
  return view(row!);
}

/**
 * Editing bumps `updatedAt`, which is what brings a dismissed banner back.
 *
 * A window that moves is a different thing to be told, so a dismissal of the
 * old wording must not silence the new one. That falls out of comparing
 * `seenVersion` to `updatedAt` rather than needing a rule of its own.
 */
export async function updateAnnouncement(
  db: Db,
  actor: Actor,
  id: string,
  input: AnnouncementInput,
): Promise<Announcement | null> {
  const [row] = await db
    .update(announcements)
    .set({
      kind: input.kind,
      startsAt: input.startsAt ? new Date(input.startsAt) : null,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      leadMinutes: input.leadMinutes,
      title: input.title.trim(),
      body: input.body?.trim() || null,
      published: input.published,
      sendMail: input.sendMail,
      updatedAt: new Date(),
    })
    .where(eq(announcements.id, id))
    .returning();

  if (!row) return null;
  await record(db, actor, "announcement.update", id, input.title);
  return view(row);
}

export async function deleteAnnouncement(db: Db, actor: Actor, id: string): Promise<boolean> {
  const [row] = await db.delete(announcements).where(eq(announcements.id, id)).returning();
  if (!row) return false;
  await record(db, actor, "announcement.delete", id, row.title);
  return true;
}

/**
 * Queues the mail for an announcement, once.
 *
 * **Maintenance goes to everybody; news respects the opt-out.** Maintenance
 * concerns the service somebody is using, and an outage nobody was told about
 * is the failure this feature exists to prevent. News is something they might
 * find interesting, which is a different thing and opt-out-able. /integritet
 * says both, in those words.
 *
 * `mailedAt` is the guard: a second publish, or an edit, does not mail twice.
 */
export async function mailAnnouncement(
  db: Db,
  id: string,
): Promise<{ queued: number } | null> {
  const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
  if (!row || !row.published || !row.sendMail || row.mailedAt) return null;

  const recipients = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        isNull(users.disabledAt),
        row.kind === "news" ? eq(profiles.newsMail, true) : sql`true`,
      ),
    );

  const subject = row.title;

  /**
   * Three renderings of one body (D128).
   *
   * The plain-text part is still the message and is still written first: D88's
   * rule survives the formatting. What changed is that the body is a small
   * Markdown subset now, so the text part flattens it and the HTML part lays it
   * out, from the same parse. Neither renders the other's output.
   */
  const body = bodyFor(row);
  const text = `${row.title}\n\n${markdownToText(body)}\n`;

  for (const recipient of recipients) {
    await queueMail(db, recipient.email, {
      template: `announcement_${row.kind}` as const,
      subject,
      text,
      // Plain text only. An announcement is a sentence, and D88's rule about no
      // images and no tracking applies here more than anywhere.
      html: htmlFor(row.title, body),
    });
  }

  await db.update(announcements).set({ mailedAt: new Date() }).where(eq(announcements.id, id));
  return { queued: recipients.length };
}

/* ------------------------------------------------------------- the user side */

export type UserAnnouncement = Announcement & { seen: boolean };

/**
 * What this person should be shown right now.
 *
 * `banner` is the maintenance notice inside its lead time and not yet dismissed
 * at its current version. `news` is every published news and notice item,
 * newest first, each marked read or not.
 */
export async function announcementsFor(
  userId: string,
  db: Db,
  now = new Date(),
): Promise<{ banner: UserAnnouncement | null; news: UserAnnouncement[]; unread: number }> {
  const rows = await db
    .select({
      row: announcements,
      seenVersion: announcementSeen.seenVersion,
    })
    .from(announcements)
    .leftJoin(
      announcementSeen,
      and(
        eq(announcementSeen.announcementId, announcements.id),
        eq(announcementSeen.userId, userId),
      ),
    )
    .where(eq(announcements.published, true))
    .orderBy(desc(announcements.createdAt));

  const decorated = rows.map(({ row, seenVersion }) => ({
    ...view(row),
    // Seen only if seen at or after the current version: an edit un-sees it.
    seen: seenVersion !== null && seenVersion.getTime() >= row.updatedAt.getTime(),
  }));

  const banner =
    decorated.find(
      (entry) => entry.kind === "maintenance" && !entry.seen && isShowing(entry, now),
    ) ?? null;

  const news = decorated.filter((entry) => entry.kind !== "maintenance");

  return { banner, news, unread: news.filter((entry) => !entry.seen).length };
}

/**
 * Whether a maintenance notice is inside its window of relevance.
 *
 * From `leadMinutes` before it starts until it ends. Not after: an outage that
 * is over is not news, and a banner about last Tuesday is the thing that
 * teaches people to dismiss banners without reading them.
 */
export function isShowing(
  entry: Pick<Announcement, "startsAt" | "endsAt" | "leadMinutes">,
  now: Date,
): boolean {
  if (!entry.startsAt) return false;
  const starts = new Date(entry.startsAt).getTime();
  const ends = entry.endsAt ? new Date(entry.endsAt).getTime() : starts;
  const from = starts - entry.leadMinutes * 60_000;
  return now.getTime() >= from && now.getTime() <= ends;
}

/** Marks one announcement seen at its current version. */
export async function markSeen(userId: string, db: Db, id: string): Promise<boolean> {
  const [row] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1);
  if (!row) return false;

  await db
    .insert(announcementSeen)
    .values({ announcementId: id, userId, seenAt: new Date(), seenVersion: row.updatedAt })
    .onConflictDoUpdate({
      target: [announcementSeen.announcementId, announcementSeen.userId],
      set: { seenAt: new Date(), seenVersion: row.updatedAt },
    });

  return true;
}

/**
 * The default maintenance body, rendered from the window.
 *
 * The second sentence is the one that matters and the reason in-app is the
 * primary channel: a planned outage stops nobody from logging, because writes
 * go to IndexedDB and sync when the app returns. Saying so turns an
 * interruption into a note.
 *
 * Times are formatted by the caller in the reader's timezone; this produces the
 * text around them.
 */
export function defaultMaintenanceBody(parts: {
  weekday: string;
  date: string;
  from: string;
  to: string;
}): string {
  return (
    `Vikt är nere för underhåll ${parts.weekday} ${parts.date} kl ${parts.from} till ${parts.to}. ` +
    "Du kan logga som vanligt under tiden, det sparas på telefonen och skickas när appen är tillbaka."
  );
}

/**
 * The title as a heading, then the body's blocks, inside the shared chrome.
 *
 * The title used to arrive as the first paragraph of the text, which made it
 * indistinguishable from the sentence under it. It is a heading, so it is set
 * as one, and `escapeHtml` runs over it for the same reason it runs over
 * everything else: an announcement title is an admin field.
 */
function htmlFor(title: string, body: string): string {
  const heading =
    `<h1 style="${ANNOUNCEMENT_STYLE.heading};margin-top:0;font-size:19px">` +
    `${escapeHtml(title)}</h1>`;

  return shell(heading + markdownToHtml(body, ANNOUNCEMENT_STYLE));
}

/** The stored body, or nothing. The default is rendered client-side, in the reader's zone. */
function bodyFor(row: typeof announcements.$inferSelect): string {
  return row.body ?? "";
}

async function record(
  db: Db,
  actor: Actor,
  action: string,
  subject: string,
  detail: string,
): Promise<void> {
  await db.insert(adminLog).values({
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    subject,
    detail,
  });
}
