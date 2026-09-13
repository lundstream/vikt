/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AnnouncementBody, AnnouncementLine } from "../../src/components/Announcement.js";

/**
 * A formatted announcement, in the app (D128).
 *
 * The parser's own tests cover what the subset is. These cover what reaches the
 * DOM: text nodes, the tags this component writes, and nothing else. There is
 * no `dangerouslySetInnerHTML` anywhere in the path, which is why "stripped"
 * is not a step that can be skipped or misconfigured.
 */

const SOURCE = [
  "## Vad som är nytt",
  "",
  "Första stycket.",
  "",
  "Andra stycket med **fetstil**.",
  "",
  "- ett",
  "- två",
].join("\n");

describe("an announcement body", () => {
  afterEach(cleanup);

  it("renders two paragraphs as two paragraphs", () => {
    const { container } = render(<AnnouncementBody markdown={SOURCE} />);

    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("fetstil");
  });

  /**
   * The heading level follows what it sits under. Under an `h2` in the news
   * list a body heading is an `h3`, and somebody navigating by headings gets an
   * outline with no holes in it.
   */
  it("places its headings below the level it was given", () => {
    const { container } = render(<AnnouncementBody markdown={SOURCE} baseLevel={2} />);
    expect(container.querySelector("h3")?.textContent).toBe("Vad som är nytt");

    cleanup();

    render(<AnnouncementBody markdown={SOURCE} baseLevel={3} />);
    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe("Vad som är nytt");
  });

  /** The security property, asserted where it would actually bite. */
  it("renders markup as characters, not as elements", () => {
    const { container } = render(
      <AnnouncementBody markdown={'Hej <script>alert(1)</script> och <b>fet</b>.'} />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("gives an external link rel=noopener and keeps a same-site one in the tab", () => {
    const { container } = render(
      <AnnouncementBody
        markdown={"[ut](https://example.test) och [in](/app/nyheter)"}
      />,
    );

    const [external, internal] = [...container.querySelectorAll("a")];
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(external?.getAttribute("rel")).toContain("noopener");
    expect(internal?.getAttribute("target")).toBeNull();
  });

  it("renders an unsafe link as its label alone", () => {
    const { container } = render(
      <AnnouncementBody markdown={"[klicka](javascript:alert(1))"} />,
    );

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("klicka");
  });

  it("renders nothing for an empty body", () => {
    const { container } = render(<AnnouncementBody markdown={"  "} />);
    expect(container.firstChild).toBeNull();
  });

  /**
   * Nothing in this path shouts. §5's sentence-case rule is about the string
   * and about the CSS, and a formatter is a new way to break the second half:
   * an `uppercase` on a heading class would put every announcement heading in
   * capitals without anybody writing one.
   */
  it("sets no class that would shout a heading", () => {
    const { container } = render(<AnnouncementBody markdown={SOURCE} />);

    for (const element of container.querySelectorAll("*")) {
      expect(element.className).not.toContain("uppercase");
    }
  });
});

describe("the banner's one line", () => {
  afterEach(cleanup);

  /**
   * A maintenance notice is a sentence beside a dismiss button. An announcement
   * with a heading and a list wanted the news page, and a banner that grew to
   * hold one would push the app down the screen on every route.
   */
  it("renders the first block and stops", () => {
    const { container } = render(<AnnouncementLine markdown={SOURCE} />);

    expect(container.textContent).toBe("Vad som är nytt");
    expect(container.querySelectorAll("li")).toHaveLength(0);
  });

  it("still formats what it does show", () => {
    const { container } = render(<AnnouncementLine markdown={"Nere **19:00**."} />);
    expect(container.querySelector("strong")?.textContent).toBe("19:00");
  });
});
