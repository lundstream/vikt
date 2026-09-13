/**
 * Transactional mail, in Swedish, plain text first (D88).
 *
 * Every message here is something a person asked for by doing something: they
 * pressed "reset my password", or they asked for an invite. There is no other
 * kind, and there will not be — this app has no reason to write to anyone
 * unprompted, and a sender that has never sent marketing is a sender nobody has
 * to unsubscribe from.
 *
 * **Plain text is the message.** The HTML variant is a courtesy for clients
 * that insist on rendering something, and it is the same words in a readable
 * width. No images, so nothing loads from a server that could log the open. No
 * tracking pixel, no click wrapper, no per-recipient link decoration: a reset
 * link is the token and nothing else, and the app does not need to know when
 * mail was read.
 *
 * The register is the app's own. It says "logga" and "väg dig", so mail says
 * "återställ" and not "vänligen initiera återställningsprocessen".
 */

export type MailTemplate =
  | "password_reset"
  | "invite_requested"
  | "invite_approved"
  /** Announcements, one per kind, so the admin queue says which (D108). */
  | "invite_request_admin"
  | "announcement_maintenance"
  | "announcement_news"
  | "announcement_notice"
  /** The admin test, which goes through the queue like everything else (D109). */
  | "test";

export type RenderedMail = {
  template: MailTemplate;
  subject: string;
  text: string;
  html: string;
};

/**
 * The HTML variant, in the profile's **light** palette (D110).
 *
 * ## Light only, and that is not a preference
 *
 * The app is dark. This is not, and it never will be:
 *
 *  - **Gmail inverts colours in dark mode.** It applies its own transform to
 *    what it decides is a light design, and a design that is already dark comes
 *    back inverted into something nobody chose. There is no reliable way to opt
 *    out across the clients that do it.
 *  - **Outlook drops most CSS.** Its Word rendering engine ignores background
 *    colours on divs, most positioning, and anything in a `<style>` block. A
 *    dark design there is dark text on the white it falls back to.
 *
 * So a dark email breaks for roughly half of any real recipient list, and a
 * light one degrades to black-on-white, which is legible everywhere. The
 * profile's light variants exist and are what this uses: Papper `#EDF1F2`,
 * Skymning `#16232B` for text, Lingon `#B0203C` for the wordmark, Sten for
 * meta.
 *
 * ## Why tables and inline styles
 *
 * Not nostalgia. Outlook's engine has no flexbox and no grid, `<style>` blocks
 * are stripped by Gmail's web client on forwarded mail, and a class that
 * survives one client is dropped by the next. A table with inline styles is the
 * one layout every client has agreed on for twenty years.
 *
 * ## What is still true from D88
 *
 * **No images.** The wordmark is the word "Vikt" in Lingon, set in text, not a
 * logo file. Nothing loads from a server, which means nothing can log an open,
 * which means there is no tracking pixel to promise the absence of.
 *
 * **The plain-text alternative is kept and is the message.** Every template
 * still writes its text first, and the HTML is that text laid out.
 */

/** The profile's light variants (page 4). The only colours in this file. */
const PAPPER = "#EDF1F2";
const SKYMNING = "#16232B";
const STEN = "#5C6B72";
const LINGON = "#B0203C";
const DIS = "#D7DEE1";

/**
 * Archivo and Inter first, then the system stack.
 *
 * Neither is loaded: a webfont in an email is an image request by another name,
 * and D88 rules those out. Naming them first means the two clients that read
 * mail on a machine where the app has been used get the app's typefaces, and
 * everyone else gets their system's, which is what they would have got anyway.
 */
const FONT =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_DISPLAY = `Archivo,${FONT}`;

/**
 * One paragraph, with every URL in it turned into a link.
 *
 * **Escape first, then linkify.** The order is the security property: the text
 * is escaped into HTML, and the anchors are built from the escaped string, so
 * there is no path by which template content becomes markup. No template here
 * interpolates HTML and none ever should, but the escaping must not depend on
 * that staying true.
 *
 * Linkified anywhere in the paragraph rather than only when a block is nothing
 * but a URL. The first version did the latter, and the invite mail's
 * "Skapa kontot här:" followed by the URL on the next line is one paragraph, so
 * the one link that matters most rendered as text somebody had to select and
 * copy. Found by looking at it.
 *
 * `word-break` on the paragraph rather than the anchor: a long reset token in a
 * 320 px viewport otherwise pushes the whole table wider than the screen.
 */
const URL_PATTERN = /https?:\/\/[^\s<]+/g;

function block(text: string): string {
  const escaped = escapeHtml(text.trim()).replace(/\n/g, "<br>");

  const linked = escaped.replace(
    URL_PATTERN,
    (url) => `<a href="${url}" style="color:${LINGON};text-decoration:underline">${url}</a>`,
  );

  return (
    `<p style="margin:0 0 18px;color:${SKYMNING};word-break:break-word">${linked}</p>`
  );
}

export function wrap(text: string): string {
  return shell(text.trim().split(/\n{2,}/).map(block).join("\n"));
}

/**
 * The chrome, around block HTML somebody else rendered (D128).
 *
 * `wrap` used to be the only way in, which meant the only thing a mail could
 * contain was paragraphs of escaped text. Announcements carry a small Markdown
 * subset now, and its renderer produces headings and lists that `block` cannot.
 * Splitting the chrome from the paragraph-maker is what lets both use the same
 * frame, wordmark and footer.
 *
 * **The caller owns the escaping.** Everything here is literal, so anything
 * passed in is markup by definition. There are exactly two callers: `wrap`,
 * which escapes, and the announcement renderer, which escapes.
 */
export function shell(body: string): string {
  return [
    // The outer table is the background. Outlook ignores a background colour on
    // a div and honours one on a table cell, which is the whole reason for it.
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`,
    ` style="background:${PAPPER};margin:0;padding:24px 0">`,
    `<tr><td align="center" style="padding:0 16px">`,

    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`,
    ` style="max-width:520px;background:${PAPPER};font-family:${FONT};font-size:15px;line-height:1.55">`,

    // The wordmark: the word, in Lingon, as text (D110).
    `<tr><td style="padding:0 0 20px">`,
    `<span style="font-family:${FONT_DISPLAY};font-size:22px;font-weight:700;`,
    `letter-spacing:-0.01em;color:${LINGON}">Vikt</span>`,
    `</td></tr>`,

    `<tr><td style="border-top:1px solid ${DIS};padding:20px 0 0;color:${SKYMNING}">`,
    body,
    `</td></tr>`,

    `<tr><td style="border-top:1px solid ${DIS};padding:16px 0 0;font-size:12px;color:${STEN}">`,
    `Det här mejlet skickades för att någon bad om det. Vikt skickar aldrig reklam,`,
    ` och det finns inga bilder eller spårning i det här mejlet.`,
    `</td></tr>`,

    `</table>`,
    `</td></tr></table>`,
  ].join("");
}

/**
 * The inline styles the Markdown renderer needs, in the mail's palette.
 *
 * Here rather than in `shared`, because the palette belongs to the templates
 * and the parser has no business knowing what Lingon is. The heading is a
 * weight and a colour rather than a size: a mail read at 15 px does not have
 * room for a type scale, and the profile's own rule is that emphasis is one
 * step, not three.
 */
export const ANNOUNCEMENT_STYLE = {
  body: `margin:0 0 18px;color:${SKYMNING};word-break:break-word`,
  heading: `margin:20px 0 8px;font-family:${FONT_DISPLAY};font-size:16px;font-weight:700;color:${SKYMNING}`,
  link: `color:${LINGON};text-decoration:underline`,
  list: `margin:0 0 18px;padding-left:20px;color:${SKYMNING}`,
} as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A reset link, and what to do if you did not ask for it.
 *
 * The "ignore this" line matters more than it looks: the request endpoint
 * answers identically whether or not an address has an account, so the only
 * signal an address holder gets is this mail — and someone who receives it
 * without asking needs to know that doing nothing is safe and sufficient.
 */
export function passwordResetMail(input: { link: string; hours: number }): RenderedMail {
  const text = `Någon har begärt ett nytt lösenord till ditt Vikt-konto.

Öppna länken för att välja ett nytt:
${input.link}

Länken fungerar en gång och slutar gälla efter ${input.hours} timme${
    input.hours === 1 ? "" : "r"
  }.

Var det inte du behöver du inte göra någonting. Ditt lösenord är oförändrat så länge du låter länken vara.

När du väljer ett nytt lösenord loggas du ut från alla enheter, även den här.`;

  return {
    template: "password_reset",
    subject: "Nytt lösenord till Vikt",
    text,
    html: wrap(text),
  };
}

/** The receipt for an invite request: it arrived, and a person will read it. */
export function inviteRequestedMail(): RenderedMail {
  const text = `Tack, din förfrågan om en inbjudningskod till Vikt har kommit fram.

Den läses av en människa, så det kan dröja. Du hör av oss antingen med en kod eller inte alls.

Adressen används bara för det här. Säger vi nej raderas den.`;

  return {
    template: "invite_requested",
    subject: "Din förfrågan om åtkomst till Vikt har kommit fram",
    text,
    html: wrap(text),
  };
}

/**
 * The other side of that receipt: an admin has something to answer (D129).
 *
 * A request sits in a list nobody has a reason to open, which is how a person
 * who asked politely waits three weeks for an answer that was one click away.
 * This is the whole point of the feature, so it is written to be actionable in
 * one read: who asked, what they said, and a link that lands on the list.
 *
 * **The address and the line are quoted, not summarised.** The decision is made
 * by reading them, and a mail that says "somebody asked" only moves the reading
 * somewhere else.
 *
 * The link goes to the requests tab, not to a per-request page: there is no
 * such page, the tab is the default view of the admin screen, and a request is
 * answered from the row.
 */
export function inviteRequestAdminMail(input: {
  name: string | null;
  email: string;
  reason: string | null;
  link: string;
}): RenderedMail {
  const who = input.name === null ? input.email : `${input.name} (${input.email})`;

  const text = [
    `${who} har bett om en inbjudningskod till Vikt.`,
    input.reason === null ? null : `Så här skrev de:\n\n${input.reason}`,
    `Svara här:\n${input.link}`,
    "Godkänner du skickas en kod. Nekar du raderas raden, och inget mejl går ut.",
    "Vill du inte ha de här mejlen kan du stänga av dem under Inställningar.",
  ]
    .filter((part) => part !== null)
    .join("\n\n");

  return {
    template: "invite_request_admin",
    subject: "Någon har bett om en kod till Vikt",
    text,
    html: wrap(text),
  };
}

/** The code itself, and where to use it. */
export function inviteApprovedMail(input: { code: string; link: string }): RenderedMail {
  const text = `Här är din inbjudningskod till Vikt:

${input.code}

Skapa kontot här:
${input.link}

Koden fungerar en gång.

Vikt är ett verktyg för att logga vikt och vanor. Det räknar fram din underhållsnivå ur dina egna siffror, och visar en trendlinje i stället för dagens våg.`;

  return {
    template: "invite_approved",
    subject: "Din inbjudningskod till Vikt",
    text,
    html: wrap(text),
  };
}

/**
 * The admin test message (D109).
 *
 * A template like any other, rather than a string literal in a route, because
 * it now goes through the queue like any other and appears in the admin list
 * beside them. Its words say what a delivered copy actually proves, which is
 * more than it used to: not only that the server accepts mail, but that the
 * drainer is running.
 */
export function testMail(): RenderedMail {
  const text = `Det här är ett testmejl från Vikt.

Får du det här fungerar utgående mejl hela vägen: mejlservern svarar, och kön töms av appen. Lösenordsåterställningar, inbjudningskoder och driftmeddelanden går samma väg.`;

  return {
    template: "test",
    subject: "Testmejl från Vikt",
    text,
    html: wrap(text),
  };
}
