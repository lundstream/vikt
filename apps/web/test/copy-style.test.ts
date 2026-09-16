import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sv } from "../src/i18n/sv.js";
import { markdownToHtml, markdownToText } from "shared";
import { allJsxStrings, componentFiles, dashPlaceholders, landingStrings } from "./jsx-copy.js";

const LANDING_FILE = path.resolve(import.meta.dirname, "../src/landing/Landing.tsx");

/** The three public pages, which share one rule about emphasis (D111). */
const PUBLIC_FILES = [
  LANDING_FILE,
  path.resolve(import.meta.dirname, "../src/landing/Privacy.tsx"),
  path.resolve(import.meta.dirname, "../src/landing/Terms.tsx"),
];

/**
 * House rules for interface copy, enforced rather than remembered.
 *
 * The dash rule is the one that prompted this file. It had been followed by
 * habit and then quietly abandoned on every screen added after Phase 2, which
 * is what happens to a rule nothing checks: it survives exactly as long as the
 * person who remembers it is paying attention. Now it is a test, so new copy
 * cannot ship without passing it, and the fix is visible at the moment of
 * writing rather than at a review three phases later.
 *
 * See CLAUDE.md §5.
 */

const entries = Object.entries(sv) as [string, string][];

/**
 * Acronyms that are genuinely written this way, and are not the app raising its
 * voice. A named list rather than a length rule: "BMI" is a word with no
 * lower-case form, "MISSAT" is a tone of voice, and only three letters separate
 * them.
 *
 * Shared by both blocks below, so the app and the landing page cannot drift
 * into disagreeing about which of them is shouting.
 */
const ACRONYMS = new Set([
  "BMI",
  "TDEE",
  "MJ",
  "PWA",
  "NNR",
  "AGPL",
  "ODBL",
  // Protocol names on the mail settings screen (D102). "STARTTLS" is how the
  // SMTP extension is spelled, not the app raising its voice, and an operator
  // matching this against their provider's documentation needs it spelled the
  // way the documentation spells it.
  "TLS",
  "STARTTLS",
  "SMTP",
  // The same, on the admin and backup screens: protocol and product names with
  // no lower-case form. An identifier in ALL_CAPS_WITH_UNDERSCORES is not
  // matched by the rule at all, because the underscore breaks the word.
  "API",
  "SMB",
  "NFS",
  // The backup destinations name these, and none has a lower-case form. "NAS"
  // and "AWS" are what the boxes and the service call themselves; "MinIO" is
  // mixed case already and is not matched by the rule.
  "NAS",
  "AWS",
  // File formats and a licence, named on the privacy and terms pages (D106).
  // "CSV" and "JSON" are how the export is labelled in the app itself, and a
  // page describing what you can take away should call it what the button does.
  "CSV",
  "JSON",
]);

/** Three or more capitals as a whole word, which is the shape of shouting. */
const SHOUTED = /(^|\s)(\p{Lu}{3,})(?=\s|$|[.,:!?])/gu;

function shoutedWords(value: string): string[] {
  return (value.match(SHOUTED) ?? []).map((match) => match.trim()).filter((word) => !ACRONYMS.has(word));
}

describe("interface copy", () => {
  /**
   * En dashes and em dashes are out. Swedish sets a parenthetical with a comma
   * or a colon, a dash in this position reads as translated-from-English, and
   * on a 360 px screen a dashed clause is where the line breaks worst. Use a
   * comma, a colon, a full stop or parentheses.
   */
  it("has no en dashes or em dashes", () => {
    const offenders = entries
      .filter(([, value]) => /[–—]/.test(value))
      .map(([key, value]) => {
        const at = value.search(/[–—]/);
        return `${key}: …${value.slice(Math.max(0, at - 30), at + 30)}…`;
      });

    expect(offenders).toEqual([]);
  });

  /**
   * A hyphen is fine — it is a word-joiner in Swedish (`Mifflin-St Jeor`,
   * `midja/längd`) and not punctuation between clauses. This asserts the rule
   * above is not over-reaching into ordinary compounds.
   */
  it("still allows an ordinary hyphen", () => {
    expect(sv["profile.sexHint"]).toContain("Mifflin-St Jeor");
  });

  /**
   * Sentence case, in the dictionary and in the CSS.
   *
   * The all-caps stat labels were converted to sentence case during the i18n
   * pass and came back during the design pass, as `uppercase tracking-wide` on
   * two elements. Nothing caught it, because the *string* was still sentence
   * case and only the rendering was shouting.
   *
   * So both halves are checked: a shouted string in `sv.ts`, and the CSS
   * transform that shouts a polite one. All-caps is a generic-SaaS tell, and
   * this app is meant to read like a notebook.
   */
  it("has no all-caps strings", () => {
    // Two-letter words are left alone so a legitimate unit or initialism is
    // not a finding.
    const offenders = entries
      .filter(([, value]) => shoutedWords(value).length > 0)
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  it("would still catch a shouted word", () => {
    expect(ACRONYMS.has("MISSAT")).toBe(false);
    expect(shoutedWords("Du har MISSAT en dag")).toEqual(["MISSAT"]);
  });

  /** A stray double space is almost always a botched dash removal. */
  it("has no doubled spaces", () => {
    const offenders = entries
      .filter(([, value]) => /\s{2,}/.test(value))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });

  /** Every value is a non-empty string: a blank one renders as missing copy. */
  it("has no empty strings", () => {
    expect(entries.filter(([, value]) => value.trim() === "").map(([key]) => key)).toEqual([]);
  });
});

/**
 * State chips are lower case (profile, page 6; D176).
 *
 * The profile's chips are "loggat", "uppskattning", "importerad" and
 * "ofullständig": a chip is a state, not a sentence, and it is set in lower
 * case. The app's estimate chip read "≈ Uppskattad", which is the wrong word
 * and the wrong case, and it had been that way since the chip was added because
 * nothing checked the component's own rule.
 *
 * The keys are found structurally rather than listed, by reading the `t("...")`
 * calls inside elements carrying the `tag` class, so a chip added next year is
 * covered without anybody remembering this test.
 */
describe("state chips", () => {
  const chipKeys = (() => {
    const found = new Set<string>();

    for (const file of componentFiles()) {
      const source = readFileSync(file, "utf8");
      /*
        A window after each `className="tag …"`, rather than the element.

        Matching to the closing tag looks right and is not: the estimate chip
        holds a nested `<span aria-hidden>≈</span>`, so a lazy match to
        `</span>` stops at the inner one and captures everything except the
        key. Three hundred characters is longer than any chip here and
        shorter than the distance to the next unrelated string.
      */
      for (const element of source.matchAll(/className=(?:"|\{`)tag[^>]*>/g)) {
        const window = source.slice(element.index, element.index + 300);
        for (const call of window.matchAll(/\bt\(\s*"([^"]+)"/g)) {
          found.add(call[1]!);
      }
      }
    }

    return [...found];
  })();

  it("finds the chips, so the check is not vacuous", () => {
    expect(chipKeys.length).toBeGreaterThanOrEqual(3);
    expect(chipKeys).toContain("estimate.badge");
  });

  it("are written in lower case", () => {
    const offenders = chipKeys
      .map((key) => [key, sv[key as keyof typeof sv]] as const)
      .filter(([, value]) => typeof value === "string" && /^\p{Lu}/u.test(value))
      .map(([key, value]) => `${key}: ${value}`);

    expect(offenders, "a chip is a state, not a sentence (profile, page 6)").toEqual([]);
  });

  /** And the estimate chip carries the profile's own word. */
  it("say what the profile says", () => {
    expect(sv["estimate.badge"]).toBe("uppskattning");
  });
});

/**
 * The same rules, on the landing page (D99).
 *
 * These checks covered `sv.ts` only, which meant the one surface a stranger
 * reads before anything else was the one surface they had never been applied
 * to. The strings are read out of the JSX by `jsx-copy.ts`, because the
 * landing page deliberately ships without the dictionary.
 */
/**
 * Every text node in the landing page's JSX, comments removed, including the
 * single words `jsxStrings` filters out.
 */
function landingTextNodes(): string[] {
  const source = readFileSync(LANDING_FILE, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  return [...source.matchAll(/(?<!=)>([^<>{}]+)</g)]
    .map((match) => (match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);
}

/** The tagline, a word to a span, in the order the page says them. */
function taglineWords(): string[] {
  const source = readFileSync(LANDING_FILE, "utf8");
  return [...source.matchAll(/className="hero-word"[^>]*>\s*([^<\s][^<]*?)\s*<\/span>/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("landing page copy", () => {
  const strings = landingStrings();

  /**
   * If the extractor ever stops finding anything, every check below passes.
   *
   * The rebuilt page (D173) is prose in seven sections rather than a strip of
   * short labels, so it has fewer and longer strings than the page this floor
   * was written against. A count alone would have to move every time the copy
   * does, so what holds the guard honest now is the section list: every heading
   * the page ships has to be among the strings being checked, and a section
   * that stopped being read would fail here by name.
   */
  it("is actually being read, section by section", () => {
    expect(strings.length).toBeGreaterThan(25);

    /*
      The tagline is one word per span now, because it arrives a word at a time
      (D179), and `jsxStrings` drops anything without a space in it: a single
      word is usually a class fragment rather than copy. So it is read out of
      the markup instead, and checked as the sentence the words make, which is
      what a reader sees.
    */
    expect(taglineWords().join(" ")).toBe("Gör det lättare.");

    for (const heading of [
      "En dagsvikt är mest brus",
      "Förbränning mäts utifrån det du loggar",
      "Vad appen gör",
      "Om AI",
      "Appen i telefonen",
      "Dina data",
    ]) {
      expect(strings, `the landing section "${heading}" is not being read`).toContain(heading);
    }
  });

  it("has no en dashes or em dashes", () => {
    const offenders = strings.filter((value) => /[–—]/.test(value));
    expect(offenders).toEqual([]);
  });

  it("has no all-caps strings", () => {
    const offenders = strings.filter((value) => shoutedWords(value).length > 0);
    expect(offenders).toEqual([]);
  });

  it("has no doubled spaces", () => {
    expect(strings.filter((value) => /\s{2,}/.test(value))).toEqual([]);
  });

  /**
   * No exclamation mark, anywhere on the page.
   *
   * The tagline ends in a full stop on purpose (D179). An exclamation mark is
   * the punctuation of a page that is selling, and this one is explaining: it
   * would be the first thing a stranger reads, and it would be the one piece of
   * the page raising its voice. §5 already refuses all-caps for the same reason,
   * and this is the same rule in the other direction.
   *
   * Read off **every** text node rather than off `strings`, because the extractor
   * drops single words and the loudest thing on a page is usually one word long.
   */
  it("never raises its voice", () => {
    const shouting = landingTextNodes().filter((value) => value.includes("!"));
    expect(shouting).toEqual([]);
  });

  /**
   * No semicolons.
   *
   * A house rule for this page rather than for the whole app, and a rule about
   * rhythm rather than grammar. A semicolon joins two clauses that could each
   * stand alone, which on a page read by someone deciding whether to trust it
   * means two claims arriving as one. Split them, and each gets its own full
   * stop and its own weight. On a 360 px screen it also removes the punctuation
   * mark most likely to end up alone at the start of a line.
   */
  it("has no semicolons", () => {
    expect(strings.filter((value) => value.includes(";"))).toEqual([]);
  });

  /**
   * No emphasis inside a paragraph, on any of the three public pages (D111).
   *
   * These pages used to open every paragraph on a bold lead-in: a short bolded
   * sentence, then the sentence that explained it. Twenty-five of them down the
   * landing page and twenty-one down /integritet, and it stops being emphasis
   * and becomes a texture. The eye reads the bold line and skips the rest,
   * which on a privacy page means skipping the part that says what actually
   * happens, and the bold half is always the claim while the plain half is
   * always the qualification.
   *
   * So the pages are plain paragraphs in Sten now. The lead-in sentences were
   * kept, unbolded, as each paragraph's first sentence, which is where they
   * were doing the work.
   *
   * Checked against the source rather than the extracted strings, because it is
   * a claim about markup and not about words. Comments are stripped first: the
   * one above this rule's own removal names the pattern it removed.
   */
  it("has no emphasis inside a paragraph", () => {
    for (const file of PUBLIC_FILES) {
      const source = readFileSync(file, "utf8")
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      const name = path.basename(file);
      expect(source, `${name} has a <strong>`).not.toMatch(/<strong\b/);
      expect(source, `${name} has a <b> or an <em>`).not.toMatch(/<(?:b|em)\b/);
      expect(source, `${name} bolds something`).not.toMatch(/font-(?:bold|semibold)/);
    }
  });

  /**
   * Proved by reintroduction, like the colour guard.
   *
   * A check that reads a file and asserts "no offenders" passes just as
   * happily when it has silently stopped looking, so both of the rules above
   * are run against copy that deliberately breaks them.
   */
  it("is what these guards are actually looking for", () => {
    const semicolon = "Modellen gissar mängden; siffrorna kommer ur databasen.";
    expect([semicolon].filter((value) => value.includes(";"))).toHaveLength(1);

    const emphasised = '<p>Det räknar <strong className="font-semibold">aldrig</strong> ut en kalori.</p>';
    expect(emphasised).toMatch(/<strong\b/);
    expect(emphasised).toMatch(/font-(?:bold|semibold)/);

    expect(shoutedWords("Du har MISSAT en dag")).toEqual(["MISSAT"]);
    // And the acronyms the page genuinely uses are not findings.
    expect(shoutedWords("Makromål från NNR 2023, öppet under AGPL")).toEqual([]);
  });
});

/**
 * The dash rule, everywhere it can be rendered from (D101).
 *
 * `interface copy` above reads `sv.ts`, which is where the app's copy is meant
 * to live. `Correlations.tsx` rendered a date range as `{from} – {to}` directly
 * in the markup, and no test could see it, because a string typed inline is a
 * string nobody was thinking of as copy.
 *
 * So this reads every `.tsx` under `src/`. It is the same rule, applied to the
 * other place the rule can be broken.
 */
describe("copy written inline, in components", () => {
  const strings = allJsxStrings();

  /** If the extractor stops finding anything, every check below passes. */
  it("is actually being read", () => {
    expect(strings.length).toBeGreaterThan(50);
    expect(strings.map((entry) => entry.file)).toContain("landing/Landing.tsx");
  });

  it("has no en dashes or em dashes", () => {
    const offenders = strings
      .filter((entry) => /[–—]/.test(entry.text))
      .map((entry) => `${entry.file}: ${entry.text.slice(0, 60)}`);

    expect(offenders).toEqual([]);
  });

  /**
   * Sentence case here too, not only in the dictionary.
   *
   * The privacy and terms pages (D106) are several hundred words of prose typed
   * straight into JSX, which is exactly the shape of thing that acquires a
   * shouted word without anybody deciding to shout.
   */
  it("has no all-caps strings", () => {
    const offenders = strings
      .filter((entry) => shoutedWords(entry.text).length > 0)
      .map((entry) => `${entry.file}: ${shoutedWords(entry.text).join(", ")}`);

    expect(offenders).toEqual([]);
  });

  /** And the two text pages are actually among what is being read. */
  it("reads the public text pages", () => {
    const files = new Set(strings.map((entry) => entry.file));
    expect(files.has("landing/Privacy.tsx")).toBe(true);
    expect(files.has("landing/Terms.tsx")).toBe(true);
  });

  /**
   * A dash is not an empty value.
   *
   * `"—"` stood in for a trend weight with no readings behind it, a height
   * nobody had entered, and four service-worker facts a browser had not
   * reported. §3 says absent is not zero and the app says what it does not know;
   * a dash says nothing at all, in the one place where saying nothing is the
   * thing the design is against. Each of the seven is now either "Inte än" or
   * the specific reason, which on the diagnostics screen is the more useful
   * half anyway: "BarcodeDetector saknas i den här webbläsaren" answers the
   * question a dash raises.
   */
  it("uses no dash as an empty-value placeholder", () => {
    const offenders = dashPlaceholders().map((entry) => `${entry.file}: ${entry.text}`);
    expect(offenders).toEqual([]);
  });

  /**
   * Proved by reintroduction. A guard that reads files and finds nothing looks
   * identical to a guard that has stopped reading.
   */
  it("is what this guard is actually looking for", () => {
    const range = "söndag 5 juli – onsdag 2 september";
    expect(/[–—]/.test(range)).toBe(true);

    // The placeholder pattern, in both the shapes it appeared in.
    expect(/["'`]\s*[–—]\s*["'`]/.test('value={x ? y : "—"}')).toBe(true);
    expect(/>\s*[–—]\s*</.test("<dd>—</dd>")).toBe(true);

    // And an ordinary hyphen is not a finding.
    expect(/[–—]/.test("Mifflin-St Jeor")).toBe(false);
  });
});

/**
 * The same guards, over a rendered announcement (D128).
 *
 * An announcement body is written at runtime, so no test can check what an
 * admin will type. What it can check is that **the renderer does not introduce
 * a violation the author did not write**, which is a real failure mode: a
 * formatter with smart typography turns two hyphens into an en dash in every
 * announcement, and a heading style with `text-transform` shouts one that was
 * typed in sentence case.
 *
 * These run the file's own `shoutedWords` and dash rule, not copies of them, so
 * the two cannot drift.
 */
describe("a rendered announcement", () => {
  const STYLE = {
    body: "margin:0",
    heading: "font-weight:700",
    link: "color:#B0203C",
    list: "padding-left:20px",
  };

  const SOURCE = [
    "## Vad som är nytt",
    "",
    "Ett streck -- och en mening till.",
    "",
    "- ett med **fetstil**",
    "- två med [en länk](https://example.test)",
  ].join("\n");

  /** Text nodes only: the HTML's own attributes are not copy. */
  const words = (html: string) => html.replace(/<[^>]*>/g, " ");

  it("gains no en dash or em dash from either renderer", () => {
    // The same rule the dictionary is held to, twenty lines up.
    expect(markdownToText(SOURCE)).not.toMatch(/[–—]/);
    expect(words(markdownToHtml(SOURCE, STYLE))).not.toMatch(/[–—]/);
  });

  it("shouts nothing that was written in sentence case", () => {
    expect(shoutedWords(markdownToText(SOURCE))).toEqual([]);
    expect(shoutedWords(words(markdownToHtml(SOURCE, STYLE)))).toEqual([]);
  });

  /** And the heading is still the words that were typed, in that case. */
  it("keeps a heading's own case", () => {
    expect(markdownToText(SOURCE)).toContain("Vad som är nytt");
    expect(markdownToHtml(SOURCE, STYLE)).toContain(">Vad som är nytt</h2>");
  });
});
