import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
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
 * component layer defines `.btn`, `.btn-small`, `.btn-link` and `.btn-impact`,
 * and Tailwind generates
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
      await generatedCss(["btn", "btn-small", "btn-primary"]),
    );

    expect(emitted.has("btn")).toBe(true);
    expect(emitted.has("btn-small")).toBe(true);
    expect(emitted.has("btn-primary")).toBe(false);
  }, 60_000);

  /**
   * The outline tier is gone and may not come back (D134).
   *
   * Three tiers remain: a filled button for an action, a text link for what is
   * not an action, and Honung for an action with a cost. `.btn-secondary` was
   * the fourth and it spent a whole visual tier on "the other button", a
   * distinction the reader does not need and the app was never consistent
   * about.
   *
   * Two halves, because either alone can be worked around. The **class** must
   * not reappear, in source or in the stylesheet. And no component may
   * hand-roll the look it had — a bordered, transparent, full-height control —
   * out of raw utilities, which is how a removed tier usually returns.
   */
  it("has no outline button style, by name or by hand", () => {
    const named = sourceFiles(SRC)
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .filter(({ source }) => /\bbtn-secondary\b/.test(source))
      .map(({ file }) => path.relative(SRC, file));

    expect(named).toEqual([]);

    /**
     * The stylesheet must not *define* it either. The rule, not the word: the
     * comment that explains why the tier was removed names it, and a check
     * that fails on its own explanation is a check nobody keeps.
     */
    const stylesheet = readFileSync(path.join(SRC, "styles/index.css"), "utf8");
    expect(stylesheet).not.toMatch(/\.btn-secondary\s*\{/);

    /**
     * A hand-rolled outline, which is the third way one gets built (D135).
     *
     * The first version of this check looked for `bg-transparent` **and** a
     * border on one line, because that is what `.btn-secondary` expanded to. It
     * caught nothing, because nobody writes `bg-transparent`: a border with no
     * background at all is transparent already. Twelve controls were built that
     * way — "Skriv in själv", "Skriv vad du åt" and "Vad kan jag laga?" among
     * them — and the guard walked straight past every one.
     *
     * So the rule is the absence, not a token: **an all-sides border with no
     * background on a control is an outline**, whatever else is on it.
     *
     * Three things are deliberately not caught:
     *
     *  - **directional borders**. `border-b` on a row is a divider, and a
     *    divider is not a button's outline;
     *  - **a choice in a set**. A control carrying `aria-pressed`, `aria-checked`
     *    or `role="radio"`/`"tab"` is expressing which one is chosen, which the
     *    profile keeps bordered on purpose (page 6, "vald skalknapp är Gran").
     *    `.chip` is the named form of that shape; a set that declares its state
     *    is a set, and one that does not is a button pretending;
     *  - **borders that live in a component class**. `.chip` and the quick
     *    action's circle carry theirs in `index.css`, where the shape is
     *    defined once and can be read.
     */
    const controls = /<(?:button|a|Link)\b[^>]*?>/gs;
    const className = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{\[([^\]]*)\])/s;

    const handRolled: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(controls)) {
        const tag = match[0];
        const found = className.exec(tag);
        if (!found) continue;

        const classes = (found[1] ?? found[2] ?? found[3] ?? "").replace(/\s+/g, " ");

        /**
         * An all-sides border **width**, which is what draws an outline.
         *
         * `border-edge` alone is a colour and paints nothing; `border-b
         * border-edge` is a divider on a row. Only a width with no side draws
         * all four, so that is what this looks for.
         *
         * Written as an explicit space-delimited match rather than
         * `\bborder\b`, because a word boundary sits inside `border-b` too and
         * the first version of this line flagged every divider in the app.
         */
        const bordered = /(^|\s)border(-[0-8])?(\s|$)/.test(classes);
        if (!bordered) continue;

        if (/\bbg-\S+/.test(classes)) continue;
        if (/aria-(pressed|checked)/.test(tag) || /role="(radio|tab)"/.test(tag)) continue;

        const line = source.slice(0, match.index).split("\n").length;
        handRolled.push(`${path.relative(SRC, file)}:${line}  ${classes.slice(0, 50)}`);
      }
    }

    expect(handRolled).toEqual([]);
  });

  /** And the three that remain all resolve, so none of them is a dead name. */
  it("emits all three button tiers", async () => {
    const emitted = emittedClassNames(
      await generatedCss(["btn", "btn-small", "btn-link", "btn-impact"]),
    );

    for (const tier of ["btn", "btn-small", "btn-link", "btn-impact"]) {
      expect(emitted.has(tier), `${tier} does not resolve`).toBe(true);
    }
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

/**
 * Honung is for actions that cost something, and for nothing else (D123).
 *
 * The profile gives Honung to "belöning" — the pot, milestone markers, "ta ut"
 * — so putting it on "radera kontot" reads at first like the palette colliding
 * with itself. The amendment: **Honung marks a thing that has a cost.** Taking
 * money out of the pot spends something; so does deleting an account. The
 * reward reading was the narrower one.
 *
 * That is a licence worth bounding. An accent that spreads is an accent that
 * stops meaning anything, and this one is easy to reach for — it is the only
 * style in the app that looks emphatic. So the list is written down here, and
 * the file a button lives in has to be on it.
 *
 * The list is by **file** rather than by test id, because the guard reads
 * source text and a test id is a string in that same text: matching on it would
 * check that a file mentions a name it also defines. The file is the coarser
 * check that actually holds — a new screen reaching for `.btn-impact` fails
 * until somebody adds it here and, in adding it, decides whether it belongs.
 */
const IMPACT_ALLOWED = new Set([
  /**
   * The mechanism rather than a use of it: `ConfirmSheet` is the sanctioned way
   * to confirm a reversible high-impact action, so it carries the style on
   * behalf of its callers. Which callers those are is checked separately below
   * — a component that renders the style for anyone would otherwise be a hole
   * straight through this list.
   */
  "components/ConfirmSheet.tsx",
  // Deleting your own account. Irreversible; typed confirmation (D123).
  "components/DeleteAccount.tsx",
  // Deleting or disabling another person's account, as an admin.
  "routes/admin/Users.tsx",
  // Changing the mail server: a wrong value stops every invite and reset
  // silently, which is D109's failure shape.
  "routes/admin/MailSettings.tsx",
  // Revoking an invite. Reversible only by minting another.
  "routes/admin/Invites.tsx",
  // Deleting a backup. **No such control exists yet** — the endpoint is not
  // built. Listed so that when it is, the style is already permitted and the
  // decision has already been taken.
  "routes/admin/Backup.tsx",
  /**
   * Removing a habit **with its history** (D137). The gentler option beside it
   * archives and keeps the ticks, and that one is an ordinary action; this one
   * deletes a run of days somebody built up and cannot be undone, which is the
   * same class as revoking an invite or deleting a backup.
   */
  "components/HabitEditor.tsx",
  /**
   * Deleting every conversation with the coach (D139). Irreversible, and the
   * thing being destroyed is a record of what somebody asked about their own
   * body, which is the same class as deleting an account's data rather than
   * the same class as tidying a list.
   */
  "routes/Coach.tsx",
]);

describe("the high-impact style", () => {
  it("appears only where an action costs something", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (IMPACT_ALLOWED.has(rel)) continue;
      if (/\bbtn-impact\b/.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }

    expect(
      offenders,
      `btn-impact is for actions with a cost; these are not on the list: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * And the component that carries it for others is opened only by actions on
   * the same list. Without this, `ConfirmSheet` would be a way to get Honung
   * onto any screen without appearing in the check above.
   */
  it("is opened only by actions on the list", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (IMPACT_ALLOWED.has(rel)) continue;
      if (/\bConfirmSheet\b/.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }

    expect(
      offenders,
      `ConfirmSheet confirms actions with a cost; these are not on the list: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /** And it is actually in use, or the check above passes by being vacuous. */
  it("is used by the actions that are on the list", () => {
    const users = [...IMPACT_ALLOWED].filter((rel) => {
      const full = path.join(SRC, rel);
      return existsSync(full) && /\bbtn-impact\b/.test(readFileSync(full, "utf8"));
    });

    expect(users.length, "nothing uses btn-impact, so the guard proves nothing")
      .toBeGreaterThanOrEqual(3);
  });

  /**
   * Snö on Natt is the primary everywhere else, and Honung must not quietly
   * become a second primary by being used for ordinary saves.
   */
  it("leaves the ordinary primary alone", () => {
    const css = readFileSync(path.join(SRC, "styles/index.css"), "utf8");
    expect(css).toMatch(/\.btn \{[\s\S]*?bg-ink[\s\S]*?text-paper/);
    expect(css).toMatch(/\.btn-impact \{[\s\S]*?bg-reward[\s\S]*?text-on-reward/);
  });
});
