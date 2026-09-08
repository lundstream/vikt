import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two rules the graphic profile cannot enforce by itself (D86).
 *
 * A palette is a document, and a document loses to a deadline. These are the
 * two claims in `docs/Vikt-grafisk-profil.pdf` that stop being true one file at
 * a time if nothing checks them, and both are checkable exactly.
 *
 *  1. **Lingon belongs to two things: the trend line and the wordmark.** That
 *     is the oldest rule in §5 and the reason the accent means anything at all —
 *     the eye knows red is *your trend* because red is never anything else. The
 *     moment it appears on a button it becomes decoration, and every use after
 *     that is free.
 *  2. **Errors, warnings and empty states get no accent.** §3 says this app has
 *     no failure state, and the profile spells out the consequence: a 422 is
 *     explained in Snö with no red frame, and "inte än" is Sten and not a
 *     coloured box. An accent on either would make a state out of an absence.
 *
 * Both are proved by reintroduction at the foot of this file: the checks are run
 * against source that deliberately breaks them, so a guard that silently stopped
 * looking would be caught.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

/** Every colour class Tailwind builds from a semantic token. */
const PREFIXES = [
  "text",
  "bg",
  "border",
  "stroke",
  "fill",
  "ring",
  "divide",
  "from",
  "to",
  "via",
  "decoration",
  "accent",
  "caret",
  "shadow",
  "outline",
];

const ACCENTS = ["trend", "logged", "data", "reward", "nutrition"] as const;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Where an accent is used in a piece of source.
 *
 * Comments are stripped first. This file and the profile's own prose talk about
 * the colours constantly, and a guard that counted the word "trend" in a
 * sentence explaining the rule would fail on documentation and pass on a
 * violation, which is the wrong way round.
 */
function accentsUsed(source: string, accents: readonly string[] = ACCENTS): Set<string> {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  const used = new Set<string>();
  for (const accent of accents) {
    const classes = new RegExp(`\\b(?:${PREFIXES.join("|")})-${accent}\\b`);
    // `tokens.trend` and friends, for the charts, which set SVG attributes.
    const reads = new RegExp(`\\btokens\\.${accent}\\b`);
    if (classes.test(code) || reads.test(code)) used.add(accent);
  }
  return used;
}

describe("Lingon belongs to the trend line and the wordmark", () => {
  /**
   * Named files rather than a count, because the rule is about *which* things,
   * and a count would pass if the wordmark lost it and a button gained it on
   * the same day.
   *
   * The third entry is profile v1.2's one exception (D99): on the landing page,
   * and only there, the single primary action may be Lingon. It is a file of
   * its own containing one element precisely so this list can keep naming
   * elements rather than pages, and the two assertions below hold that
   * boundary — the file stays one element, and nothing inside `/app` imports it.
   */
  const ALLOWED = [
    "components/TrendChart.tsx",
    "components/Wordmark.tsx",
    "landing/LandingPrimary.tsx",
  ];

  it("appears in exactly those files", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => accentsUsed(readFileSync(file, "utf8"), ["trend"]).has("trend"))
      .map((file) => path.relative(SRC, file).replaceAll("\\", "/"))
      .sort();

    expect(offenders).toEqual([...ALLOWED].sort());
  });

  /**
   * The exception is one element, and it stays one element.
   *
   * "The landing page may use Lingon" would have been an exception to a rule
   * about files, and would then permit the accent anywhere on a page several
   * hundred lines long. This is what keeps it narrower than that.
   */
  it("grants the landing exception to exactly one element", () => {
    const file = readFileSync(path.join(SRC, "landing/LandingPrimary.tsx"), "utf8");
    const code = file
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const uses = code.match(/\b(?:bg|text|border|fill|stroke|ring)-trend\b/g) ?? [];
    expect(uses).toHaveLength(1);

    // One element, and it is an anchor: the exception is for *the* action, so a
    // component that grew a second button would show up here.
    expect(code.match(/<a\b/g) ?? []).toHaveLength(1);
    expect(code).not.toMatch(/<button\b/);
  });

  /**
   * And it never reaches the app. Profile v1.2 is explicit that inside `/app`
   * the rule is unchanged, so the exception has to stay on the landing side of
   * the two entry points (D90).
   */
  it("is never imported from inside the app", () => {
    const importers = sourceFiles(SRC)
      .filter((file) => /["'].*LandingPrimary\.js["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file).replaceAll("\\", "/"));

    expect(importers).toEqual(["landing/Landing.tsx"]);
  });

  it("is what the guard is actually looking for", () => {
    // Reintroduction: a button that reaches for the accent must be caught.
    expect(accentsUsed('<button className="bg-trend">Spara</button>').has("trend")).toBe(true);
    expect(accentsUsed('<Line stroke={tokens.trend} />').has("trend")).toBe(true);
    // And prose about the rule must not be.
    expect(accentsUsed("/** The trend is drawn in text-trend, nothing else is. */").size).toBe(0);
  });
});

describe("errors, warnings and empty states get no accent", () => {
  /**
   * The components that exist to say something did not happen, or has not
   * happened yet. If one of them gains an accent it has become a *state*, and
   * §3 is explicit that this app does not have one.
   */
  const NO_ACCENT = [
    // A field's error message, which is where a 422 lands.
    "components/Field.tsx",
    // Sync and offline state: "not sent yet" is an absence, not a fault.
    "components/SyncIndicator.tsx",
    // The queue inspector, whose whole content is writes that did not land.
    "routes/Settings.tsx",
  ];

  it("holds for every one of them", () => {
    for (const relative of NO_ACCENT) {
      const source = readFileSync(path.join(SRC, relative), "utf8");
      expect(
        [...accentsUsed(source)],
        `${relative} uses an accent; errors, warnings and empty states get none`,
      ).toEqual([]);
    }
  });

  it("is what the guard is actually looking for", () => {
    // Reintroduction, one per rule the profile names.
    expect(accentsUsed('<p className="border-trend">422</p>').size).toBeGreaterThan(0);
    expect(accentsUsed('<p className="text-logged">Inte än</p>').has("logged")).toBe(true);
    expect(accentsUsed('<div className="bg-reward" />').has("reward")).toBe(true);
    // Sten is not an accent, so uncertainty may use it freely.
    expect(accentsUsed('<p className="text-uncertain">Inte än</p>').size).toBe(0);
  });
});

/**
 * No component names a colour.
 *
 * The palette lives under its Norrland names in `tokens.css` and is not exposed
 * as Tailwind classes at all, so this catches the other route: a raw hex typed
 * into a component, which is how a fifth green enters an app.
 */
describe("colours are named by meaning, never directly", () => {
  it("finds no raw hex in any component", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Data URIs in CSS-in-JS would be a false positive; there are none, and
      // if one appears it belongs in a stylesheet anyway.
      if (/#[0-9a-fA-F]{6}\b/.test(code)) {
        offenders.push(path.relative(SRC, file).replaceAll("\\", "/"));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("does not expose the palette names as classes", () => {
    const config = readFileSync(
      path.resolve(import.meta.dirname, "../tailwind.config.js"),
      "utf8",
    );
    for (const palette of ["lingon", "gran", "is", "honung", "blabar", "natt", "skymning"]) {
      expect(config).not.toMatch(new RegExp(`\\b${palette}:`));
    }
  });
});
