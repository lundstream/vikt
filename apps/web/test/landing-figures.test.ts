import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The landing page's figure strip says something checkable (D97).
 *
 * Three numbers sit at the top of the public page, and the whole argument the
 * page makes is that this app does not round its own measurements. Two of them
 * are facts about the deployment and cannot drift. The third is
 * a measurement, and measurements drift: someone adds a confirmation step, the
 * repeat path becomes three taps, and the landing page goes on saying two
 * because nobody thought of it while doing something else.
 *
 * So it is pinned to the place the measurement is recorded. If the fast-path
 * table in docs/measurements.md changes and the page does not, this fails, and the failure
 * message is the one worth reading: the page is now claiming something that was
 * true last month.
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LANDING = readFileSync(path.join(ROOT, "apps/web/src/landing/Landing.tsx"), "utf8");
const MEASURED = readFileSync(path.join(ROOT, "docs/measurements.md"), "utf8");
const PRIVACY = readFileSync(path.join(ROOT, "apps/web/src/landing/Privacy.tsx"), "utf8");

/** The row of the fast-path table that the strip quotes. */
function measuredRepeatTaps(): number {
  const row = MEASURED.split("\n").find((line) => line.includes("repeat food, cold open to logged"));
  expect(row, "docs/measurements.md no longer has a repeat-food row in its fast-path table").toBeTruthy();

  // The last figure on the row is the current one; earlier columns are history.
  const taps = [...row!.matchAll(/(\d+)\s+taps?/g)].at(-1);
  expect(taps, `no tap count in: ${row}`).toBeTruthy();
  return Number(taps![1]);
}

/**
 * The figure strip, as a list of `{ value, unit }` pairs.
 *
 * Anchored on the two keys next to each other rather than on the start of the
 * object, because the cards gained an icon and a tint in front of them (D99)
 * and an anchor on `{` silently matched nothing.
 */
function stripFigures(): { value: string; unit: string }[] {
  return [...LANDING.matchAll(/\bvalue:\s*"([^"]*)",\s*unit:\s*"([^"]*)"/g)].map((m) => ({
    value: m[1]!,
    unit: m[2]!,
  }));
}

describe("the landing page's figure strip", () => {
  it("quotes the tap figure that was actually measured", () => {
    const claimed = stripFigures().find((figure) => figure.unit === "tryck");
    expect(claimed, "the strip no longer carries a tap figure").toBeTruthy();
    expect(Number(claimed!.value)).toBe(measuredRepeatTaps());
  });

  it("carries exactly three figures, and one of them is the price", () => {
    const figures = stripFigures();
    expect(figures).toHaveLength(3);
    expect(figures.map((figure) => `${figure.value} ${figure.unit}`)).toContain("0 kr");
  });

  /**
   * A claim on the strip is a claim the privacy page also makes (D111).
   *
   * The card this exists for used to say "100 % av din data ligger på din egen
   * server", which is true for a reader who self-hosts and false for a reader
   * on somebody else's instance. The page cannot tell them apart, so it must
   * not say it. What replaced it is a claim about third parties, and a claim
   * about third parties has exactly one authoritative version: the one on
   * /integritet.
   *
   * Each figure that makes such a claim names the sentence it condenses, and
   * this checks that sentence is still on the page word for word. Reword either
   * side and this fails, which is the point: a summary that outlives the thing
   * it summarises is how the old card got there.
   */
  it("condenses claims the privacy page actually makes", () => {
    const sources = [...LANDING.matchAll(/\bsource:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(sources.length, "no figure names a privacy-page sentence").toBeGreaterThan(0);

    for (const sentence of sources) {
      expect(PRIVACY, `/integritet no longer says: ${sentence}`).toContain(sentence);
    }

    // And no card claims the data sits on the reader's own hardware, which is
    // only true of a self-hosted installation. Checked against the card labels
    // rather than the file: the AI section says the same words about the model
    // host, where they are conditional and true.
    const labels = [...LANDING.matchAll(/label:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(labels.join(" | ")).not.toContain("egen server");
  });

  /**
   * Not decoration. Each one is a real capture of the running app at 360 px
   * (D97), and a section whose screenshot went missing would still lay out
   * correctly with a broken image, which is exactly why this is worth pinning.
   */
  it("shows four screenshots, each of which exists", () => {
    const sources = [...LANDING.matchAll(/src="(\/screens\/[^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(sources).size).toBe(4);

    for (const source of sources) {
      const file = path.join(ROOT, "apps/web/public", source);
      expect(() => readFileSync(file), `${source} is referenced but not in public/`).not.toThrow();
    }
  });
});
