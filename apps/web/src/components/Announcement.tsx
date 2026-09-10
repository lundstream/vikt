import { Fragment } from "react";
import { parseMarkdown, type MarkdownInline } from "shared";

/**
 * An announcement body, as React elements (D128).
 *
 * No `dangerouslySetInnerHTML` and no sanitiser. The parser produces a tree of
 * three block types and three inline types, and this walks it: every string
 * that reaches the DOM does so as a text node, which React escapes, so raw HTML
 * in an admin's textarea renders as the characters they typed. There is nothing
 * to strip because there is nothing that could have become markup.
 *
 * ## Heading levels are a prop
 *
 * The same body appears under an `h1` on the news page and under an `h2` in the
 * list, and a heading level that does not follow what is above it is a hole in
 * the document outline for anybody navigating by headings. So the caller says
 * where in the outline this body sits, and the two levels the subset allows are
 * placed below it.
 *
 * ## The list styling is deliberate
 *
 * `list-disc` and `list-decimal` with an indent, rather than the app's own
 * borderless rows. A list inside a paragraph of prose is prose, and the marker
 * is what says "these are items" when there is no other structure around them.
 */
export function AnnouncementBody({
  markdown,
  baseLevel = 2,
  className = "",
}: {
  markdown: string;
  /** The heading level of whatever this body sits under. Its own start below it. */
  baseLevel?: 1 | 2 | 3;
  className?: string;
}) {
  const blocks = parseMarkdown(markdown);
  if (blocks.length === 0) return null;

  return (
    <div className={`space-y-2 text-note text-muted ${className}`.trim()}>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return (
            <p key={index} className="max-w-prose">
              <Spans children={block.children} />
            </p>
          );
        }

        if (block.type === "heading") {
          const level = Math.min(baseLevel + block.level, 6);
          const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
          return (
            <Tag key={index} className="pt-1 text-note font-semibold text-ink">
              <Spans children={block.children} />
            </Tag>
          );
        }

        const List = block.ordered ? "ol" : "ul";
        return (
          <List
            key={index}
            className={`max-w-prose space-y-1 pl-5 ${
              block.ordered ? "list-decimal" : "list-disc"
            }`}
          >
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Spans children={item} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/**
 * The one-paragraph form, for places that have room for a sentence and not for
 * a document: the maintenance banner, which is a line beside a dismiss button.
 *
 * It renders the first block's spans and nothing else. A maintenance notice
 * with a heading and a list in it is an announcement that wanted the news page,
 * and truncating it there is better than a banner that grows to fill the top of
 * every screen in the app.
 */
export function AnnouncementLine({ markdown }: { markdown: string }) {
  const [first] = parseMarkdown(markdown);
  if (!first) return null;

  const spans = first.type === "list" ? (first.items[0] ?? []) : first.children;
  return <Spans children={spans} />;
}

function Spans({ children }: { children: MarkdownInline[] }) {
  return (
    <>
      {children.map((span, index) => {
        if (span.type === "strong") {
          return (
            <strong key={index} className="font-semibold text-ink">
              {span.value}
            </strong>
          );
        }

        if (span.type === "link") {
          /**
           * `noopener noreferrer` on every one of these. The href comes from an
           * admin field, and an announcement linking somewhere off this
           * installation must not hand that page a handle on the tab it came
           * from. The parser has already refused every scheme but http, https,
           * mailto and a same-site path.
           */
          return (
            <a
              key={index}
              href={span.href}
              className="underline underline-offset-4 hover:text-ink"
              target={span.href.startsWith("/") ? undefined : "_blank"}
              rel="noopener noreferrer"
            >
              {span.value}
            </a>
          );
        }

        return <Fragment key={index}>{span.value}</Fragment>;
      })}
    </>
  );
}
