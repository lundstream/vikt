/**
 * A very small Markdown subset, for announcement bodies (D128).
 *
 * An announcement used to be one paragraph of plain text, rendered by dropping
 * the string into a `<p>` in the app and into `wrap()` for the mail. That is
 * fine for "we are restarting on Tuesday" and useless for a release note, which
 * wants a heading, a list of what changed, and a link.
 *
 * ## Why a parser here and not a library
 *
 * The same body is rendered in three places that cannot share a renderer: React
 * elements in the app, an HTML string in the mail, and plain text for the
 * mail's text part. A library gives an HTML string, so two of the three would
 * have to go through `dangerouslySetInnerHTML` and a sanitiser, and the
 * sanitiser would then be the thing standing between an admin field and script
 * in every reader's browser.
 *
 * This parses to a tiny tree instead. The tree has three block types and three
 * inline types and cannot express anything else, so **there is no markup to
 * strip**: raw HTML in the source is text, because text is the only thing the
 * parser can produce from it. Sanitising is not a pass over the output, it is
 * the shape of the type.
 *
 * ## The subset, and why it stops there
 *
 * Paragraphs, two heading levels, bold, bullet and numbered lists, links. That
 * is what a release note needs. Not italics, which is indistinguishable from
 * bold at 12 px in a mail client and which §5 rules out anyway as a second
 * voice arguing with the first. Not images, per D88's rule that no mail from
 * here carries one. Not tables, not code, not nested lists.
 *
 * Headings are `1` and `2` rather than `h2` and `h3`, because the level a body
 * heading takes depends on what sits above it: the news list already spends
 * `h2` on the announcement's own title. Each renderer maps them.
 */

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "link"; href: string; value: string };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: 1 | 2; children: MarkdownInline[] }
  | { type: "list"; ordered: boolean; items: MarkdownInline[][] };

/**
 * Schemes a link may use.
 *
 * Everything else keeps its words and loses its link, which is the failure mode
 * worth having: `javascript:` and `data:` are the two that turn a link into an
 * attack, and a reader who sees the label without the link has lost nothing
 * they could safely have had.
 */
const SAFE_SCHEME = /^(https?:\/\/|mailto:|\/)/i;

const HEADING = /^(#{2,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d{1,3}[.)]\s+(.*)$/;

/** `**bold**` or `[label](href)`, whichever comes first. */
const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/;

/**
 * Source to blocks.
 *
 * Line-based and deliberately unclever. A blank line ends a block, a heading is
 * its own block, and consecutive list markers of the same kind are one list.
 * Anything else is a paragraph line, joined to its neighbours with a space, so
 * a hard-wrapped paragraph in the admin textarea is one paragraph. That is what
 * somebody typing into a 60-column box means.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const closeParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  const closeList = () => {
    if (list === null) return;
    blocks.push({ type: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };

  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();

    if (line === "") {
      closeAll();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeAll();
      blocks.push({
        type: "heading",
        level: heading[1]!.length === 2 ? 1 : 2,
        children: parseInline(heading[2]!.trim()),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);

    if (bullet || numbered) {
      const ordered = numbered !== null;
      closeParagraph();
      // A bullet list directly under a numbered one is two lists, not one list
      // with a confused marker.
      if (list !== null && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ? bullet[1]! : numbered![1]!).trim());
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeAll();
  return blocks;
}

/**
 * Inline spans, left to right.
 *
 * No nesting: bold inside a link, or a link inside bold, is one more thing that
 * has to be right in three renderers, to buy an emphasis nobody asked for. The
 * inner text of either is taken literally.
 */
export function parseInline(source: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let rest = source;

  for (;;) {
    const match = INLINE.exec(rest);
    if (!match) break;

    if (match.index > 0) out.push({ type: "text", value: rest.slice(0, match.index) });

    if (match[1] !== undefined) {
      out.push({ type: "strong", value: match[1] });
    } else {
      const href = match[3]!;
      out.push(
        SAFE_SCHEME.test(href)
          ? { type: "link", href, value: match[2]! }
          : { type: "text", value: match[2]! },
      );
    }

    rest = rest.slice(match.index + match[0].length);
  }

  if (rest !== "") out.push({ type: "text", value: rest });
  return out;
}

/** Every inline span's words, unmarked. */
function inlineText(children: MarkdownInline[]): string {
  return children
    .map((span) => (span.type === "link" ? `${span.value} (${span.href})` : span.value))
    .join("");
}

/**
 * The plain-text part of a mail.
 *
 * Links carry their target in parentheses, because a text part that says "läs
 * mer" with nowhere to go is worse than a visible URL. Headings are bare lines:
 * no hashes, no underlining, no capitals, because §5's sentence-case rule does
 * not stop applying when the renderer changes. Lists keep a marker, since a
 * list without one reads as a paragraph that lost its punctuation.
 */
export function markdownToText(source: string): string {
  const parts: string[] = [];

  for (const block of parseMarkdown(source)) {
    if (block.type === "paragraph" || block.type === "heading") {
      parts.push(inlineText(block.children));
      continue;
    }

    parts.push(
      block.items
        .map((item, index) =>
          block.ordered ? `${index + 1}. ${inlineText(item)}` : `- ${inlineText(item)}`,
        )
        .join("\n"),
    );
  }

  return parts.join("\n\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inline styles for the mail, since a mail client has no stylesheet.
 *
 * Passed in rather than imported, because the palette lives with the templates
 * and this module has no business knowing what Lingon is.
 */
export type MarkdownHtmlStyle = {
  body: string;
  heading: string;
  link: string;
  list: string;
};

/**
 * Blocks to an HTML string, for the mail.
 *
 * Every value goes through `escapeHtml`, the href included. There is no path
 * from source to markup: the only tags in the output are the ones written on
 * these lines, because the tree cannot carry any others.
 */
export function markdownToHtml(source: string, style: MarkdownHtmlStyle): string {
  const inline = (children: MarkdownInline[]): string =>
    children
      .map((span) => {
        const text = escapeHtml(span.value);
        if (span.type === "text") return text;
        if (span.type === "strong") return `<strong>${text}</strong>`;
        return `<a href="${escapeHtml(span.href)}" style="${style.link}">${text}</a>`;
      })
      .join("");

  return parseMarkdown(source)
    .map((block) => {
      if (block.type === "paragraph") {
        return `<p style="${style.body}">${inline(block.children)}</p>`;
      }

      if (block.type === "heading") {
        const tag = block.level === 1 ? "h2" : "h3";
        return `<${tag} style="${style.heading}">${inline(block.children)}</${tag}>`;
      }

      const tag = block.ordered ? "ol" : "ul";
      const items = block.items.map((item) => `<li>${inline(item)}</li>`).join("");
      return `<${tag} style="${style.list}">${items}</${tag}>`;
    })
    .join("");
}
