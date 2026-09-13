import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import { outboundEmail, profiles, users } from "../src/db/schema.js";
import {
  announcementsFor,
  createAnnouncement,
  defaultMaintenanceBody,
  deleteAnnouncement,
  isShowing,
  mailAnnouncement,
  markSeen,
  updateAnnouncement,
} from "../src/services/announcement.service.js";

/**
 * Announcements (D108).
 *
 * The three properties worth pinning are the ones a reader would notice going
 * wrong: a banner appears inside its window and not outside it, a dismissal
 * survives until the announcement changes and not after, and news mail respects
 * the opt-out while maintenance mail does not.
 */

const WINDOW = {
  startsAt: "2026-09-10T19:00:00.000Z",
  endsAt: "2026-09-10T21:00:00.000Z",
  leadMinutes: 1440,
};

function maintenance(overrides: Partial<Parameters<typeof createAnnouncement>[2]> = {}) {
  return {
    kind: "maintenance" as const,
    ...WINDOW,
    title: "Underhåll",
    body: null,
    published: true,
    sendMail: false,
    ...overrides,
  };
}

describe("when a maintenance banner is showing", () => {
  const entry = { ...WINDOW };

  it("appears once the lead time starts and not before", () => {
    // A day and a minute before: outside. A day before: inside.
    expect(isShowing(entry, new Date("2026-09-09T18:59:00.000Z"))).toBe(false);
    expect(isShowing(entry, new Date("2026-09-09T19:30:00.000Z"))).toBe(true);
  });

  it("stays up through the window", () => {
    expect(isShowing(entry, new Date("2026-09-10T20:00:00.000Z"))).toBe(true);
  });

  /**
   * And stops. An outage that is over is not news, and a banner about last
   * Tuesday is what teaches people to dismiss banners without reading them.
   */
  it("goes away when the window ends", () => {
    expect(isShowing(entry, new Date("2026-09-10T21:00:01.000Z"))).toBe(false);
  });

  it("shows nothing at all without a window", () => {
    expect(isShowing({ ...entry, startsAt: null }, new Date())).toBe(false);
  });
});

describe("the default maintenance body", () => {
  /**
   * The second sentence is the point, and the reason in-app is the primary
   * channel: a planned outage stops nobody from logging.
   */
  it("says that logging keeps working", () => {
    const body = defaultMaintenanceBody({
      weekday: "torsdag",
      date: "10 september",
      from: "21:00",
      to: "23:00",
    });

    expect(body).toContain("torsdag 10 september");
    expect(body).toContain("21:00");
    expect(body).toContain("sparas på telefonen");
    // §5: no dashes in interface copy.
    expect(body).not.toMatch(/[–—]/);
  });
});

describe("what a reader is shown", () => {
  const ctx = useTestApp();

  async function admin() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { user, actor: { id: user.userId, email: user.email } };
  }

  it("gets the banner inside its window, and not a draft", async () => {
    const { db } = ctx();
    const { user, actor } = await admin();

    await createAnnouncement(db, actor, maintenance({ published: false }));
    expect((await announcementsFor(user.userId, db, new Date("2026-09-10T20:00:00.000Z"))).banner)
      .toBeNull();

    await createAnnouncement(db, actor, maintenance());
    const shown = await announcementsFor(user.userId, db, new Date("2026-09-10T20:00:00.000Z"));
    expect(shown.banner?.title).toBe("Underhåll");
  });

  it("stops showing it once dismissed", async () => {
    const { db } = ctx();
    const { user, actor } = await admin();
    const created = await createAnnouncement(db, actor, maintenance());
    const at = new Date("2026-09-10T20:00:00.000Z");

    expect((await announcementsFor(user.userId, db, at)).banner).not.toBeNull();
    await markSeen(user.userId, db, created.id);
    expect((await announcementsFor(user.userId, db, at)).banner).toBeNull();
  });

  /**
   * The property that makes a dismissal safe to offer: an announcement whose
   * window moves is a different thing to be told, so the old dismissal does not
   * silence the new wording.
   */
  it("shows it again when the announcement changes", async () => {
    const { db } = ctx();
    const { user, actor } = await admin();
    const created = await createAnnouncement(db, actor, maintenance());
    const at = new Date("2026-09-10T20:00:00.000Z");

    await markSeen(user.userId, db, created.id);
    expect((await announcementsFor(user.userId, db, at)).banner).toBeNull();

    await updateAnnouncement(db, actor, created.id, maintenance({ title: "Underhåll, ny tid" }));
    const again = await announcementsFor(user.userId, db, at);
    expect(again.banner?.title).toBe("Underhåll, ny tid");
  });

  /** One person dismissing does not dismiss it for anybody else. */
  it("is dismissed per person", async () => {
    const { app, db } = ctx();
    const { user, actor } = await admin();
    const other = await createUser(app, db);
    const created = await createAnnouncement(db, actor, maintenance());
    const at = new Date("2026-09-10T20:00:00.000Z");

    await markSeen(user.userId, db, created.id);
    expect((await announcementsFor(other.userId, db, at)).banner).not.toBeNull();
  });

  /**
   * News never becomes a banner. It goes on its own page and the only
   * interruption is a dot on Mer.
   */
  it("keeps news out of the banner and in the list", async () => {
    const { db } = ctx();
    const { user, actor } = await admin();

    await createAnnouncement(db, actor, {
      kind: "news",
      startsAt: null,
      endsAt: null,
      leadMinutes: 0,
      title: "Ny skärm",
      body: "Det finns en sida för meddelanden nu.",
      published: true,
      sendMail: false,
    });

    const shown = await announcementsFor(user.userId, db);
    expect(shown.banner).toBeNull();
    expect(shown.news).toHaveLength(1);
    expect(shown.unread).toBe(1);

    await markSeen(user.userId, db, shown.news[0]!.id);
    expect((await announcementsFor(user.userId, db)).unread).toBe(0);
  });
});

describe("announcement mail", () => {
  const ctx = useTestApp();

  async function admin() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    return { user, actor: { id: user.userId, email: user.email } };
  }

  /** News respects the opt-out. That is what makes it an opt-out. */
  it("skips people who have turned news mail off", async () => {
    const { app, db } = ctx();
    const { actor } = await admin();
    const optedOut = await createUser(app, db);
    await db
      .update(profiles)
      .set({ newsMail: false })
      .where(eq(profiles.userId, optedOut.userId));

    const created = await createAnnouncement(db, actor, {
      kind: "news",
      startsAt: null,
      endsAt: null,
      leadMinutes: 0,
      title: "Ny skärm",
      body: "Något nytt.",
      published: true,
      sendMail: true,
    });

    await mailAnnouncement(db, created.id);
    const queued = await db.select().from(outboundEmail);
    expect(queued.map((row) => row.toAddress)).not.toContain(optedOut.email);
    expect(queued.map((row) => row.toAddress)).toContain(actor.email);
  });

  /**
   * Maintenance does not. It concerns the service somebody is using, and an
   * outage nobody was told about is the failure this feature exists to prevent.
   */
  it("mails maintenance to everybody, opt-out or not", async () => {
    const { app, db } = ctx();
    const { actor } = await admin();
    const optedOut = await createUser(app, db);
    await db
      .update(profiles)
      .set({ newsMail: false })
      .where(eq(profiles.userId, optedOut.userId));

    const created = await createAnnouncement(db, actor, maintenance({ sendMail: true }));
    await mailAnnouncement(db, created.id);

    const queued = await db.select().from(outboundEmail);
    expect(queued.map((row) => row.toAddress)).toContain(optedOut.email);
  });

  /** A second publish, or an edit, does not mail the same thing twice. */
  it("mails once", async () => {
    const { db } = ctx();
    const { actor } = await admin();
    const created = await createAnnouncement(db, actor, maintenance({ sendMail: true }));

    expect(await mailAnnouncement(db, created.id)).not.toBeNull();
    expect(await mailAnnouncement(db, created.id)).toBeNull();
    expect(await db.select().from(outboundEmail)).toHaveLength(1);
  });

  it("mails nothing for a draft", async () => {
    const { db } = ctx();
    const { actor } = await admin();
    const created = await createAnnouncement(
      db,
      actor,
      maintenance({ published: false, sendMail: true }),
    );

    expect(await mailAnnouncement(db, created.id)).toBeNull();
    expect(await db.select().from(outboundEmail)).toHaveLength(0);
  });
});

describe("the admin endpoints", () => {
  const ctx = useTestApp();

  it("are a 404 for a non-admin, like every other admin route", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/announcements",
      headers: auth(user),
    });
    expect(response.statusCode).toBe(404);
  });

  /** Edit and delete ship with the create (§3, D56). */
  it("create, edit and delete, each in the audit log", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    const actor = { id: user.userId, email: user.email };

    const created = await createAnnouncement(db, actor, maintenance());
    expect(await updateAnnouncement(db, actor, created.id, maintenance({ title: "Ändrad" })))
      .not.toBeNull();
    expect(await deleteAnnouncement(db, actor, created.id)).toBe(true);
    expect(await deleteAnnouncement(db, actor, created.id)).toBe(false);

    const log = (
      await app.inject({ method: "GET", url: "/api/admin/log", headers: auth(user) })
    ).json().entries as { action: string }[];

    const actions = log.map((row) => row.action);
    expect(actions).toContain("announcement.create");
    expect(actions).toContain("announcement.update");
    expect(actions).toContain("announcement.delete");
  });
});

/**
 * A formatted announcement, in the mail (D128).
 *
 * Both parts, from one body. D88's rule that the plain-text part is the message
 * survives the formatting: the text part is still written first and still says
 * everything the HTML does, including where the links go.
 */
describe("mailing a formatted announcement", () => {
  const ctx = useTestApp();

  const BODY = [
    "## Vad som är nytt",
    "",
    "Första stycket.",
    "",
    "Andra stycket med **fetstil** och [en länk](https://example.test).",
    "",
    "- ett",
    "- två",
  ].join("\n");

  async function mailed() {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    const actor = { id: user.userId, email: user.email };

    const created = await createAnnouncement(db, actor, {
      kind: "news",
      startsAt: null,
      endsAt: null,
      leadMinutes: 0,
      title: "Ny skärm",
      body: BODY,
      published: true,
      sendMail: true,
    });

    await mailAnnouncement(db, created.id);
    const [row] = await db.select().from(outboundEmail);
    return row!;
  }

  it("renders two paragraphs as two paragraphs in the HTML part", async () => {
    const { bodyHtml } = await mailed();

    expect(bodyHtml!.match(/<p /g)).toHaveLength(2);
    expect(bodyHtml).toContain("<h2 ");
    expect(bodyHtml!.match(/<li>/g)).toHaveLength(2);
    expect(bodyHtml).toContain("<strong>fetstil</strong>");

    // The title is a heading rather than the first paragraph of the body.
    expect(bodyHtml).toContain(">Ny skärm</h1>");

    // And the chrome is still the light template: wordmark, rule, footer.
    expect(bodyHtml).toContain("Vikt</span>");
    expect(bodyHtml).toContain("inga bilder eller spårning");
  });

  it("renders two paragraphs as two paragraphs in the text part", async () => {
    const { bodyText } = await mailed();
    const paragraphs = bodyText.trim().split("\n\n");

    // Title, heading, paragraph, paragraph, list.
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[0]).toBe("Ny skärm");
    expect(paragraphs[1]).toBe("Vad som är nytt");
    expect(paragraphs[4]).toBe("- ett\n- två");

    // A text part that says "en länk" with nowhere to go is worse than a URL.
    expect(bodyText).toContain("en länk (https://example.test)");

    // No marks left in it. A text part full of asterisks is a formatter
    // leaking into the one rendering that has no formatting.
    expect(bodyText).not.toContain("**");
    expect(bodyText).not.toContain("## ");
  });

  /** Markup an admin typed is characters in both parts, never elements. */
  it("carries no markup out of the body", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, user.userId));
    const actor = { id: user.userId, email: user.email };

    const created = await createAnnouncement(db, actor, {
      kind: "news",
      startsAt: null,
      endsAt: null,
      leadMinutes: 0,
      title: "Hej <b>du</b>",
      body: "Hej <script>alert(1)</script>.",
      published: true,
      sendMail: true,
    });

    await mailAnnouncement(db, created.id);
    const [row] = await db.select().from(outboundEmail);

    expect(row!.bodyHtml).not.toContain("<script>");
    expect(row!.bodyHtml).toContain("&lt;script&gt;");
    // The title too: it is an admin field like any other.
    expect(row!.bodyHtml).toContain("&lt;b&gt;du&lt;/b&gt;");
  });
});
