import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inviteApprovedMail,
  inviteRequestedMail,
  passwordResetMail,
  testMail,
  type RenderedMail,
} from "../src/mail/templates.js";
import { isAbsoluteUrl, linkTo, NoPublicBaseUrl, publicBaseUrl } from "../src/lib/links.js";
import type { Env } from "../src/env.js";

/**
 * What every mail has to be true of (D109, D110).
 *
 * The first block is the one that exists because of a real defect: an invite
 * mail went out with `/app/register?kod=…` in it, a relative URL, which no mail
 * client can resolve. Nothing failed, the queue said sent, and the recipient got
 * a code they could not use.
 */

const BASE = { PUBLIC_BASE_URL: "https://vikt.example.test", PUBLIC_ORIGIN: "" } as Env;

/** Every template, rendered with plausible input. */
const TEMPLATES: [string, RenderedMail][] = [
  [
    "invite_approved",
    inviteApprovedMail({
      code: "3F7K-9QMT-2XBW",
      link: linkTo(BASE, "/app/register", { kod: "3F7K-9QMT-2XBW" }),
    }),
  ],
  ["invite_requested", inviteRequestedMail()],
  [
    "password_reset",
    passwordResetMail({ link: linkTo(BASE, "/app/nytt-losenord", { token: "abc" }), hours: 2 }),
  ],
  ["test", testMail()],
];

describe("links in mail", () => {
  /** The test the brief asked for, and the defect it would have caught. */
  it("is absolute in every template, in the text and in the HTML", () => {
    for (const [name, mail] of TEMPLATES) {
      for (const found of mail.text.match(/\S*\/app\/\S*/g) ?? []) {
        expect(isAbsoluteUrl(found), `${name}: ${found} is not absolute`).toBe(true);
      }
      for (const href of [...mail.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)) {
        expect(isAbsoluteUrl(href), `${name}: href ${href} is not absolute`).toBe(true);
      }
    }
  });

  it("builds a link from the base, with the query it was given", () => {
    expect(linkTo(BASE, "/app/register", { kod: "AB-CD" })).toBe(
      "https://vikt.example.test/app/register?kod=AB-CD",
    );
    // A trailing slash on the base does not become a double slash.
    expect(
      linkTo({ PUBLIC_BASE_URL: "https://x.test/", PUBLIC_ORIGIN: "" } as Env, "/app/"),
    ).toBe("https://x.test/app/");
  });

  /**
   * The old name still works, so an upgrade does not silently lose every link.
   * It is a fallback, not a second source of truth: the new name wins.
   */
  it("falls back to PUBLIC_ORIGIN, and prefers the new name", () => {
    expect(
      publicBaseUrl({ PUBLIC_BASE_URL: "", PUBLIC_ORIGIN: "https://old.test" } as Env),
    ).toBe("https://old.test");
    expect(
      publicBaseUrl({ PUBLIC_BASE_URL: "https://new.test", PUBLIC_ORIGIN: "https://old.test" } as Env),
    ).toBe("https://new.test");
  });

  /**
   * Configured with nothing, a link is not silently relative. Throwing is what
   * turns this into a queue row with a readable error rather than a mail with a
   * dead link in it.
   */
  it("refuses to build a link with no base configured", () => {
    const empty = { PUBLIC_BASE_URL: "", PUBLIC_ORIGIN: "" } as Env;
    expect(publicBaseUrl(empty)).toBeNull();
    expect(() => linkTo(empty, "/app/register")).toThrow(NoPublicBaseUrl);
  });

  it("knows what absolute means", () => {
    expect(isAbsoluteUrl("https://x.test/a")).toBe(true);
    expect(isAbsoluteUrl("http://x.test/a")).toBe(true);
    // The shape that shipped.
    expect(isAbsoluteUrl("/app/register?kod=AB")).toBe(false);
    expect(isAbsoluteUrl("mailto:a@b.test")).toBe(false);
    expect(isAbsoluteUrl("")).toBe(false);
  });
});

describe("the HTML variant", () => {
  /**
   * The three rules from D88 that a redesign is most likely to break, and the
   * two from D110 about what survives in a mail client.
   */
  it("loads nothing from anywhere", () => {
    for (const [name, mail] of TEMPLATES) {
      expect(/<img/i.test(mail.html), `${name} has an image`).toBe(false);
      expect(/background-image/i.test(mail.html), `${name} has a background image`).toBe(false);
      expect(/<script/i.test(mail.html), `${name} has a script`).toBe(false);
    }
  });

  /**
   * Gmail's web client strips `<style>` blocks on forwarded mail and Outlook's
   * engine ignores most of what is in one, so every rule is inline (D110).
   */
  it("uses inline styles and tables, not a stylesheet or flexbox", () => {
    for (const [name, mail] of TEMPLATES) {
      expect(/<style/i.test(mail.html), `${name} has a style block`).toBe(false);
      expect(/display:\s*(flex|grid)/i.test(mail.html), `${name} uses flex or grid`).toBe(false);
      expect(mail.html.includes("<table"), `${name} is not table-based`).toBe(true);
    }
  });

  /** The profile's light variants, and the wordmark as text (D110). */
  it("is the light palette, with Vikt set in Lingon as text", () => {
    for (const [name, mail] of TEMPLATES) {
      expect(mail.html, `${name} is not on Papper`).toContain("#EDF1F2");
      expect(mail.html, `${name} has no wordmark`).toContain("#B0203C");
      expect(mail.html).toMatch(/>Vikt<\/span>/);
      // The dark background would be inverted by Gmail into something nobody
      // chose, so it must not appear as a surface.
      expect(mail.html.includes("background:#0F1418")).toBe(false);
    }
  });

  it("keeps a plain-text alternative that says the same thing", () => {
    for (const [name, mail] of TEMPLATES) {
      expect(mail.text.trim().length, `${name} has no text part`).toBeGreaterThan(40);
      // Not markup pretending to be text.
      expect(/<[a-z]/i.test(mail.text), `${name}'s text part contains markup`).toBe(false);
    }
  });

  /** §5 applies to mail: no en dashes or em dashes, and nothing shouted. */
  it("follows the copy rules", () => {
    for (const [name, mail] of TEMPLATES) {
      expect(/[–—]/.test(mail.text), `${name} has a dash`).toBe(false);
      expect(/[–—]/.test(mail.subject), `${name}'s subject has a dash`).toBe(false);

      const shouted = (mail.text.match(/(^|\s)(\p{Lu}{3,})(?=\s|$|[.,:!?])/gu) ?? [])
        .map((word) => word.trim())
        .filter((word) => !["PDF", "SMTP"].includes(word));
      expect(shouted, `${name} shouts`).toEqual([]);
    }
  });

  /**
   * Writes the rendered set to `test-output/mail-preview.html` as a by-product.
   *
   * Not an assertion. It is how the layout gets looked at without sending
   * anything, and having the test write it means the artefact cannot drift from
   * the templates the way a separate preview script would.
   */
  it("renders a preview anybody can open", () => {
    const dir = path.resolve(import.meta.dirname, "../test-output");
    mkdirSync(dir, { recursive: true });

    const page = TEMPLATES.map(
      ([name, mail]) =>
        `<h2 style="font:600 13px sans-serif;color:#555;padding:24px 16px 4px;margin:0">` +
        `${name} · ${mail.subject}</h2>${mail.html}`,
    ).join("\n");

    writeFileSync(
      path.join(dir, "mail-preview.html"),
      `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">${page}</body>`,
    );

    expect(page.length).toBeGreaterThan(1000);
  });
});
