import { describe, expect, it } from "vitest";
import {
  markdownToHtml,
  markdownToText,
  parseInline,
  parseMarkdown,
  type MarkdownHtmlStyle,
} from "./markdown.js";

/**
 * The announcement subset (D128).
 *
 * Two properties matter more than the formatting: **there is no path from an
 * admin's textarea to markup**, and **the three renderings agree about what the
 * blocks are**. The rest is convenience.
 */

const STYLE: MarkdownHtmlStyle = {
  body: "b",
  heading: "h",
  link: "l",
  list: "u",
};

describe("the subset", () => {
  it("makes two paragraphs out of two paragraphs", () => {
    const blocks = parseMarkdown("Första stycket.\n\nAndra stycket.");

    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
  });

  /** A hard-wrapped paragraph is one paragraph, which is what a textarea means. */
  it("joins wrapped lines into one paragraph", () => {
    const blocks = parseMarkdown("En mening som\nfortsätter på nästa rad.");

    expect(blocks).toHaveLength(1);
    expect(markdownToText("En mening som\nfortsätter på nästa rad.")).toBe(
      "En mening som fortsätter på nästa rad.",
    );
  });

  it("has two heading levels and no more", () => {
    const blocks = parseMarkdown("## Ett\n\n### Två\n\n#### Tre");

    expect(blocks[0]).toMatchObject({ type: "heading", level: 1 });
    expect(blocks[1]).toMatchObject({ type: "heading", level: 2 });
    // A fourth hash is not a third level: it is text, because the subset stops.
    expect(blocks[2]?.type).toBe("paragraph");
  });

  it("reads both list kinds, and does not merge them", () => {
    const blocks = parseMarkdown("- ett\n- två\n1. första\n2. andra");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("reads bold and links", () => {
    expect(parseInline("en **viktig** sak")).toEqual([
      { type: "text", value: "en " },
      { type: "strong", value: "viktig" },
      { type: "text", value: " sak" },
    ]);

    expect(parseInline("se [hjälpen](https://example.test/hjalp)")).toEqual([
      { type: "text", value: "se " },
      { type: "link", href: "https://example.test/hjalp", value: "hjälpen" },
    ]);
  });
});

describe("what it refuses", () => {
  /**
   * The whole security argument. The parser cannot produce a node that carries
   * markup, so raw HTML is text in every renderer by construction.
   */
  it("treats raw HTML as text, in all three renderings", () => {
    const source = 'Hej <script>alert(1)</script> och <b>fet</b>.';

    const blocks = parseMarkdown(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "paragraph" });

    // Plain text keeps the characters as characters.
    expect(markdownToText(source)).toContain("<script>");

    // HTML escapes them, so nothing in the output is a tag but the ones the
    // renderer wrote itself.
    const html = markdownToHtml(source, STYLE);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;");
  });

  /**
   * `javascript:` keeps its words and loses its link.
   *
   * The href stops at the first closing paren, so a URL containing one leaves
   * the remainder as text. That is the right way round: an href that swallowed
   * everything up to the last paren on the line would be a parser deciding how
   * much of a sentence belongs to a link.
   */
  it("drops a link with an unsafe scheme, keeping the label", () => {
    const spans = parseInline("[klicka](javascript:alert(1))");

    expect(spans.some((span) => span.type === "link")).toBe(false);
    expect(spans[0]).toEqual({ type: "text", value: "klicka" });
    expect(markdownToHtml("[klicka](javascript:alert(1))", STYLE)).not.toContain("<a");
  });

  it("allows http, https, mailto and a same-site path", () => {
    for (const href of [
      "https://example.test",
      "http://example.test",
      "mailto:någon@example.test",
      "/app/nyheter",
    ]) {
      expect(parseInline(`[x](${href})`)[0]).toMatchObject({ type: "link", href });
    }

    for (const href of ["data:text/html,x", "vbscript:x", "file:///etc/passwd"]) {
      expect(parseInline(`[x](${href})`)[0]).toEqual({ type: "text", value: "x" });
    }
  });

  /** A quote in a link label cannot break out of the attribute. */
  it("escapes the href as well as the text", () => {
    const html = markdownToHtml('[a"b](https://example.test/?q="x")', STYLE);

    expect(html).toContain("&quot;");
    expect(html.match(/href="[^"]*"/)?.[0]).toBe('href="https://example.test/?q=&quot;x&quot;"');
  });
});

describe("the three renderings", () => {
  const SOURCE = [
    "## Vad som är nytt",
    "",
    "Första stycket.",
    "",
    "Andra stycket med **fetstil** och [en länk](https://example.test).",
    "",
    "- ett",
    "- två",
  ].join("\n");

  it("renders two paragraphs as two paragraphs in HTML", () => {
    const html = markdownToHtml(SOURCE, STYLE);

    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).toContain("<h2 ");
    expect(html).toContain("<ul ");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain("<strong>fetstil</strong>");
  });

  it("renders two paragraphs as two paragraphs in plain text", () => {
    const text = markdownToText(SOURCE);
    const paragraphs = text.split("\n\n");

    // Heading, paragraph, paragraph, list.
    expect(paragraphs).toHaveLength(4);
    expect(paragraphs[0]).toBe("Vad som är nytt");
    expect(paragraphs[3]).toBe("- ett\n- två");
  });

  /** A text part that says "en länk" with nowhere to go is worse than a URL. */
  it("carries a link's target into the text part", () => {
    expect(markdownToText(SOURCE)).toContain("en länk (https://example.test)");
  });

  /**
   * §5's copy rules do not stop applying when the renderer changes (D128).
   *
   * A renderer that turned `--` into an en dash, or set a heading in capitals,
   * would put a house-style violation into every announcement without anybody
   * writing one. Neither does, and this is what says so.
   */
  it("introduces no dashes and shouts nothing", () => {
    const source = "## En rubrik\n\nEtt streck -- och tre punkter ...";

    for (const rendered of [markdownToText(source), markdownToHtml(source, STYLE)]) {
      expect(rendered).not.toMatch(/[–—]/);
      expect(rendered).not.toContain("…");
    }

    expect(markdownToText(source)).toContain("En rubrik");
    expect(markdownToHtml(source, STYLE)).toContain(">En rubrik</h2>");
  });

  it("renders an empty body as nothing at all", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
    expect(markdownToText("")).toBe("");
    expect(markdownToHtml("", STYLE)).toBe("");
  });
});
