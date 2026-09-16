import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { componentFiles } from "./jsx-copy.js";

/**
 * Every text colour is readable on every surface it can land on (D175).
 *
 * The profile promises 4,5:1 and the dark theme did not hold it. Sten measured
 * **4,22 on Natt, 3,65 on Skymning and 3,22 on Dis**, which is every meta line,
 * every "inte än" and every unit beside a figure, below AA at the 12 px it is
 * set at. It survived because nothing computed it: the light theme's Sten had
 * been corrected once, by hand, with a comment, and the dark theme's had not.
 *
 * So this computes it, from `tokens.css` itself, for every pair. A palette value
 * edited in either theme fails here rather than in somebody's eyes.
 *
 * ## What is held to what
 *
 * **Body text is Snö and Sten** (profile, page 3: "För brödtext används bara Snö
 * och Sten"), and body text is held to **4,5:1 on every surface**: the page, the
 * card and the raised surface that fields and chips sit on.
 *
 * **The five accents are large text and graphics**, which WCAG puts at 3:1, and
 * the profile makes one promise about them: they clear 4,5:1 against Natt. Both
 * are asserted, and the accent promise is asserted for the **dark** theme,
 * because that is the theme page 3's values are for and the one it claims it of.
 */

const TOKENS = readFileSync(
  path.resolve(import.meta.dirname, "../src/styles/tokens.css"),
  "utf8",
);

/* ------------------------------------------------------------ the arithmetic -- */

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const clean = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(clean.slice(at, at + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

/** WCAG 2.1's contrast ratio, which is what "4,5:1" means. */
export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/* -------------------------------------------------------- reading the tokens -- */

/** The declarations inside one block, as written. */
function block(selector: string): Map<string, string> {
  const at = TOKENS.indexOf(`${selector} {`);
  expect(at, `tokens.css has no ${selector} block`).toBeGreaterThan(-1);

  const open = TOKENS.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < TOKENS.length; i += 1) {
    if (TOKENS[i] === "{") depth += 1;
    if (TOKENS[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const declarations = new Map<string, string>();
  for (const match of TOKENS.slice(open, end).matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1]!, match[2]!.trim());
  }
  return declarations;
}

const light = block(":root");
const dark = block(".dark");

/**
 * What a semantic token resolves to in one theme.
 *
 * The semantic names live in `:root` and point at palette names; the palette is
 * what each theme swaps. That is the whole design (D86), and it is why this can
 * resolve a theme by looking one name up in the other map.
 */
function resolve(name: string, palette: Map<string, string>): string {
  let value = light.get(name) ?? palette.get(name);
  for (let hops = 0; hops < 5 && value?.startsWith("var("); hops += 1) {
    const inner = value.slice(4, -1).trim();
    value = palette.get(inner) ?? light.get(inner);
  }
  expect(value, `${name} does not resolve to a colour`).toMatch(/^#[0-9a-f]{6}$/i);
  return value!;
}

/** Text a reader is meant to read, as opposed to a mark they are meant to see. */
const BODY_TEXT = ["--ink", "--muted", "--uncertain"];

/** Everything a piece of text can sit on. */
const SURFACES = ["--paper", "--card", "--field"];

/** The five areas, which are marks and large figures rather than prose. */
const ACCENTS = ["--trend", "--logged", "--data", "--reward", "--nutrition"];

const THEMES = [
  { name: "dark", palette: dark },
  { name: "light", palette: light },
] as const;

describe("body text is readable on every surface", () => {
  it("reads the tokens, so the check is not vacuous", () => {
    expect(resolve("--muted", dark)).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolve("--muted", dark)).not.toBe(resolve("--muted", light));
    expect(SURFACES.map((name) => resolve(name, dark))).toHaveLength(3);
  });

  for (const theme of THEMES) {
    for (const text of BODY_TEXT) {
      for (const surface of SURFACES) {
        it(`${theme.name}: ${text} on ${surface}`, () => {
          const ratio = contrast(resolve(text, theme.palette), resolve(surface, theme.palette));
          expect(
            Number(ratio.toFixed(2)),
            `${text} ${resolve(text, theme.palette)} on ${surface} ${resolve(surface, theme.palette)} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});

describe("the accents", () => {
  /**
   * Page 3's own claim, about the theme page 3 is written for.
   *
   * Not the light theme: its Is and Honung are 3,34 and 3,50 against Papper,
   * and the profile does not claim otherwise. They are marks there, at 3:1.
   */
  it("clear 4,5:1 against Natt, which is what the profile promises", () => {
    for (const accent of ACCENTS) {
      const ratio = contrast(resolve(accent, dark), resolve("--paper", dark));
      expect(Number(ratio.toFixed(2)), `${accent} on Natt is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  /**
   * And they stay visible as marks wherever they are drawn, in both themes.
   *
   * **On the page and on a card, not on Dis.** Dis is the field, the raised
   * surface and the hairline, and no component puts an accent on one: the test
   * below reads the source and holds that true, because the moment something
   * does, this exclusion stops being safe. It matters: the light theme's Is on
   * Dis measures **2,78:1**, which would fail even the 3:1 bar for a mark.
   */
  const DRAWN_ON = ["--paper", "--card"];

  for (const theme of THEMES) {
    it(`${theme.name}: every accent is at least 3:1 where it is drawn`, () => {
      for (const accent of ACCENTS) {
        for (const surface of DRAWN_ON) {
          const ratio = contrast(resolve(accent, theme.palette), resolve(surface, theme.palette));
          expect(
            Number(ratio.toFixed(2)),
            `${accent} on ${surface} is ${ratio.toFixed(2)}:1 in the ${theme.name} theme`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }

  it("is not asked to skip Dis by something that actually uses it", () => {
    const sources = componentFiles();
    const offenders = sources
      .filter((file) => {
        const code = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        return /bg-field[^"'`]*text-(trend|logged|data|reward|nutrition)/.test(code);
      })
      .map((file) => path.relative(path.resolve(import.meta.dirname, "../src"), file));

    expect(offenders, "an accent is being drawn on Dis, so the exclusion above is no longer safe").toEqual([]);
  });
});

/**
 * The landing page's one action, which is text **on** an accent (D179).
 *
 * Everything above checks text on a surface or an accent drawn on one. The
 * primary button is neither: Natt set on Lingon, the one place the profile lets
 * this page use the accent (D99). Nothing was holding that pair, and it is the
 * tightest one in the tree.
 *
 * It was found by a Lighthouse run that scored accessibility 93 with a contrast
 * failure naming `#c43e55`, a colour that is in no stylesheet: axe had sampled
 * the button **part way through its fade in**, so the background it measured
 * was Lingon at 86 % over Natt. Two more runs scored 100. The audit was
 * flickering, and what it was flickering around is a pair with 0,08 of headroom
 * over the floor, which is why it is written down here rather than left to the
 * next run's timing.
 */
describe("the landing page's primary action", () => {
  it("is readable at rest, which is the only state it is really in", () => {
    const ratio = contrast(resolve("--paper", dark), resolve("--trend", dark));
    expect(
      Number(ratio.toFixed(2)),
      `Natt on Lingon is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * And it is worth knowing how little room there is. This is not a second
   * assertion of the same thing: it fails if somebody makes the pair *worse*
   * while still passing, which is the change that would put the next audit back
   * into the flicker above.
   */
  it("has as much headroom as it had when this was written", () => {
    const ratio = contrast(resolve("--paper", dark), resolve("--trend", dark));
    expect(Number(ratio.toFixed(2))).toBeGreaterThanOrEqual(4.57);
  });
});

describe("the check itself", () => {
  /** Proved by reintroduction, like the colour and copy guards. */
  it("is what it is looking for", () => {
    // The value this decision replaced, on the surface that found it.
    expect(Number(contrast("#6b7b82", "#16232b").toFixed(2))).toBe(3.65);
    // And the obvious correction, which passes Skymning and still fails Dis.
    expect(Number(contrast("#7a8b92", "#1e2d36").toFixed(2))).toBe(4.0);
    // Black on white is the textbook maximum.
    expect(Math.round(contrast("#000000", "#ffffff"))).toBe(21);
  });
});
