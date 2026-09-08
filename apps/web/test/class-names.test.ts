import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import tailwind from "tailwindcss";
// The config is plain JS with no declaration file, and giving it one for the
// sake of a test would be the tail wagging the dog.
// @ts-expect-error -- untyped JS config, read for its content only
import config from "../tailwind.config.js";

/**
 * Every class name the app uses must resolve to a real rule.
 *
 * This exists because `btn-primary` shipped twice. It is not a class: the
 * component layer defines `.btn` and `.btn-secondary`, and Tailwind generates
 * nothing for a name it does not recognise. The result is not an error, it is a
 * `<button>` with no padding — which is exactly the kind of defect that gets
 * through, because **tests assert values, not the path taken to produce them**.
 * Every test still passed; the button was 24 px tall and only a measured
 * tap-target check in a real browser caught it.
 *
 * The check asks Tailwind itself rather than maintaining a list of known
 * classes. Anything the compiler emits no rule for is reported, which covers
 * utilities, variants, arbitrary values and the hand-written component layer
 * with one mechanism and no allowlist to fall out of date.
 */

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(WEB, "src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Reads the expression attached to each `className`, whether it is a plain
 * string or a braced expression, by counting brackets rather than by regex:
 * `className={[...].join(" ")}` and nested ternaries both appear in this
 * codebase and neither survives a naive match.
 */
function classNameExpressions(source: string): string[] {
  const regions: string[] = [];
  const attr = /className\s*=\s*/g;

  for (let match = attr.exec(source); match !== null; match = attr.exec(source)) {
    let i = match.index + match[0].length;

    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i]!;
      const end = source.indexOf(quote, i + 1);
      if (end === -1) continue;
      regions.push(source.slice(i, end + 1));
      continue;
    }

    if (source[i] !== "{") continue;

    let depth = 0;
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    regions.push(source.slice(start, i + 1));
  }

  return regions;
}

/**
 * Class names, from the string literals inside those expressions.
 *
 * Only the static parts of a template literal are read. A name assembled at
 * runtime from a variable cannot be checked here and is deliberately skipped
 * rather than guessed at: reporting `var(--` as a missing class would make the
 * test noise, and noise is how a guard stops being trusted.
 */
function classNamesIn(source: string): string[] {
  const names: string[] = [];

  for (const region of classNameExpressions(source)) {
    for (const literal of region.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      const text = literal[1] ?? literal[2] ?? literal[3] ?? "";
      if (text.includes("${")) continue;
      for (const token of text.split(/\s+/)) {
        if (token !== "") names.push(token);
      }
    }
  }

  return names;
}

/**
 * The class names Tailwind actually emitted, read back out of the compiled CSS.
 *
 * Reading the output is the reliable direction. Building the selector Tailwind
 * *would* emit means reimplementing its escaping, and that is not a small rule:
 * `bg-[var(--ink)]/70` becomes `.bg-\\[var\\(--ink\\)\\]\\/70`, and a comma inside an
 * arbitrary value becomes the CSS hex escape `\\2c `. A first attempt at this
 * test reported three perfectly good classes as missing for exactly that
 * reason, which is the failure mode a guard can least afford.
 */
function emittedClassNames(css: string): Set<string> {
  const names = new Set<string>();

  postcss.parse(css).walkRules((rule) => {
    // `\2c ` is one escape *including* its trailing space, so it has to be
    // matched before the generic `\.` alternative, or the space ends the
    // token mid-escape and the name comes back mangled.
    for (const match of rule.selector.matchAll(
      /\.((?:\\[0-9a-fA-F]{1,6} ?|\\.|[\w-])+)/g,
    )) {
      names.add(unescapeCss(match[1]!));
    }
  });

  return names;
}

/** `\2c ` and `\[` back to `,` and `[`. */
function unescapeCss(selector: string): string {
  return selector
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, "$1");
}

async function generatedCss(classNames: readonly string[]): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "vikt-classes-"));
  const probe = path.join(dir, "probe.txt");
  writeFileSync(probe, [...new Set(classNames)].join("\n"), "utf8");

  const entry = readFileSync(path.join(SRC, "styles/index.css"), "utf8")
    // The token file is a plain `@import` and postcss is not resolving imports
    // here; the component layer below it is what this test cares about.
    .replace('@import "./tokens.css";', "");

  const result = await postcss([
    tailwind({ ...config, content: [probe] }),
  ]).process(entry, { from: path.join(SRC, "styles/index.css") });

  return result.css;
}

describe("class names", () => {
  const used = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    for (const name of classNamesIn(readFileSync(file, "utf8"))) {
      if (!used.has(name)) used.set(name, path.relative(SRC, file));
    }
  }

  it("finds the class names actually used, so the check is not vacuous", () => {
    expect(used.size).toBeGreaterThan(80);
    expect(used.has("btn")).toBe(true);
  });

  it("every one resolves to a rule", async () => {
    const emitted = emittedClassNames(await generatedCss([...used.keys()]));

    const unresolved = [...used]
      .filter(([name]) => !emitted.has(name))
      .map(([name, file]) => `${name} (${file})`);

    expect(unresolved).toEqual([]);
  }, 60_000);

  /**
   * Proof by reintroduction: the check must actually fail on the class that
   * caused it to be written, or it is decoration.
   */
  it("would have caught btn-primary", async () => {
    const emitted = emittedClassNames(
      await generatedCss(["btn", "btn-secondary", "btn-primary"]),
    );

    expect(emitted.has("btn")).toBe(true);
    expect(emitted.has("btn-secondary")).toBe(true);
    expect(emitted.has("btn-primary")).toBe(false);
  }, 60_000);

  /**
   * The second family, found by the first version of this test.
   *
   * `bg-[var(--logged)]` *does* emit a rule, so the resolution check above
   * passes it, and the declaration is still dead: the tokens in `tokens.css`
   * are space-separated RGB **channels** (`61 89 67`) so that Tailwind's
   * `<alpha-value>` works, and `background-color: 61 89 67` is not a colour.
   * The browser drops it silently. Seven files were doing this.
   *
   * So a raw token reference in a colour position is banned outright. The
   * token-aware class (`bg-logged`) is the form that works, and it is shorter.
   */
  it("never references a raw token where a colour is expected", () => {
    const offenders: string[] = [];

    for (const [name, file] of used) {
      if (/(?:bg|text|border|accent|fill|stroke|ring|divide|from|to|via)-\[var\(--/.test(name)) {
        offenders.push(`${name} (${file})`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The other half of the sentence-case rule (`copy-style.test.ts` holds the
   * string half).
   *
   * `uppercase` shouts a string that is written politely, so the dictionary
   * check cannot see it. This is what actually regressed: two elements on the
   * dashboard picked up `uppercase tracking-wide` during the design pass and
   * put "SENASTE VÄGNINGARNA" and "KALORIER I DAG" back on screen.
   */
  it("never sets a CSS uppercase transform", () => {
    const offenders = [...used]
      .filter(([name]) => name === "uppercase" || name.endsWith(":uppercase"))
      .map(([name, file]) => `${name} (${file})`);

    expect(offenders).toEqual([]);
  });

  /** And it must not report a perfectly good arbitrary value as missing. */
  it("handles arbitrary values and opacity modifiers", async () => {
    const tricky = [
      "pb-[max(1.25rem,env(safe-area-inset-bottom))]",
      "h-[46vh]",
      "lg:grid-cols-3",
      "bg-ink/70",
    ];
    const emitted = emittedClassNames(await generatedCss(tricky));

    expect(tricky.filter((name) => !emitted.has(name))).toEqual([]);
  }, 60_000);

  /**
   * Proof by reintroduction for the other defect this found: an opacity
   * modifier on a raw `var()` produces no rule whatsoever, which is why the
   * celebration dialog's backdrop was fully transparent.
   */
  it("would have caught the transparent modal backdrop", async () => {
    const emitted = emittedClassNames(
      await generatedCss(["bg-[var(--ink)]/70", "bg-ink/70"]),
    );

    expect(emitted.has("bg-[var(--ink)]/70")).toBe(false);
    expect(emitted.has("bg-ink/70")).toBe(true);
  }, 60_000);
});
