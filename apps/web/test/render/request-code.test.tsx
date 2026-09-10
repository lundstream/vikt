/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Landing } from "../../src/landing/Landing.js";
import { RequestCode } from "../../src/landing/RequestCode.js";

/**
 * The request form is not on the landing page any more (D127).
 *
 * The landing page may be read by anybody, and every code approved from it
 * makes whoever runs the installation responsible for another person's weight,
 * meals and address. So the form lives at the unlinked /kod, behind
 * `REQUEST_ENABLED`, off by default.
 *
 * These render the two components directly. The gate itself is not here and
 * cannot be: it is nginx refusing the path and the API not registering the
 * route, which `invite-request.test.ts` covers. What is here is that the
 * landing page carries nothing that posts anywhere, and that the page which
 * does still carries what guarded it.
 */

describe("the landing page", () => {
  afterEach(cleanup);

  it("has no form and nothing pointing at one", () => {
    const { container } = render(<Landing />);

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    // Not even a link: /kod is unlinked, on every installation.
    expect(container.querySelector('a[href*="kod"]')).toBeNull();
  });

  /**
   * What replaced the second button has to be true for every reader: somebody
   * with a code, somebody without one, and somebody on an installation that
   * hands out none.
   */
  it("says the app needs an invitation and points at the source", () => {
    const { container } = render(<Landing />);
    const text = container.textContent ?? "";

    expect(text).toContain("kräver en inbjudan");
    expect(text).toContain("egen server");

    const github = [...container.querySelectorAll("a")].filter((link) =>
      (link.textContent ?? "").includes("GitHub"),
    );
    // One in the top bar, one in the hero sentence, one in the footer.
    expect(github.length).toBeGreaterThanOrEqual(2);
    for (const link of github) {
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  /**
   * One primary action, which is what lets it be Lingon at all (D99). The
   * secondary button that used to sit beside it is a sentence now, so the hero
   * holds exactly one control and no button anywhere on the page is styled as
   * an alternative to it.
   */
  it("leads with exactly one button, and no second one", () => {
    const { container } = render(<Landing />);

    const primary = container.querySelectorAll("main a.bg-trend");
    expect(primary).toHaveLength(1);
    expect(primary[0]?.getAttribute("href")).toBe("/app");

    expect(container.querySelectorAll("main .btn-secondary")).toHaveLength(0);
  });
});

describe("/kod", () => {
  afterEach(cleanup);

  it("is the form, with its own title", () => {
    render(<RequestCode />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Be om en kod");
    expect(screen.getByLabelText(/Namn/)).toBeTruthy();
    expect(screen.getByLabelText(/E-post/)).toBeTruthy();
  });

  /** The honeypot came with it, unreachable and unannounced. */
  it("keeps the honeypot out of reach", () => {
    const { container } = render(<RequestCode />);

    const trap = container.querySelector('div[aria-hidden="true"] input');
    expect(trap).toBeTruthy();
    expect(trap?.getAttribute("tabindex")).toBe("-1");
  });

  /** And it still says what the human check is, on the page that runs it. */
  it("says what the browser check does", () => {
    const { container } = render(<RequestCode />);
    expect(container.textContent).toContain("robotar");
  });
});
