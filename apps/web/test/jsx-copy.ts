import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Human-readable strings pulled straight out of JSX (D99, D101).
 *
 * `copy-style.test.ts` began by iterating `i18n/sv.ts`, which is where the app's
 * copy is supposed to live. Two surfaces were therefore never checked:
 *
 *  - the landing page, which ships without the dictionary on purpose (D90), and
 *  - anything written as a literal in a component instead of a dictionary key,
 *    which is exactly where the rules get broken, because a string typed inline
 *    is a string nobody was thinking of as copy.
 *
 * The second one is the interesting case. `Correlations.tsx` rendered a date
 * range as `{from} – {to}` with a real en dash in the markup, and the dictionary
 * test could not see it. So this reads the source.
 *
 * ## What it is conservative about
 *
 * Deliberately in one direction only. A technical string that slips through is a
 * false failure, noticed immediately and easy to filter. A piece of copy that is
 * filtered out is merely unchecked, which is where every one of these files
 * already was. So `isCopy` rejects things that cannot be prose and lets the rest
 * through.
 */

const WEB_SRC = path.resolve(import.meta.dirname, "../src");

/** Attributes and object keys that hold machinery rather than words. */
const TECHNICAL_ATTRIBUTES =
  /\s(?:className|href|src|id|rel|target|to|type|role|tabIndex|autoComplete|autoCapitalize|inputMode|maxLength|minLength|pattern|loading|key|name|htmlFor|accept|capture|aria-hidden|aria-live|aria-controls|aria-labelledby|data-[a-z-]+)=(?:"[^"]*"|\{[^}]*\})/g;
const TECHNICAL_KEYS = /^\s*(?:tint|icon|href|to|external|key|testId|queryKey|className):/;

export type CopyString = { text: string; file: string };

/** Every `.tsx` under `src/`, which is where JSX can be. */
export function componentFiles(dir: string = WEB_SRC): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...componentFiles(full));
    else if (entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** The strings a reader would see, from one file. */
export function jsxStrings(file: string): CopyString[] {
  const source = readFileSync(file, "utf8");
  const relative = path.relative(WEB_SRC, file).replaceAll("\\", "/");

  const code = source
    // Comments first. These files explain the copy rules at length, and a guard
    // that failed on the explanation would pass on a violation.
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    // Then imports, which are paths rather than prose.
    .replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, "")
    // And dictionary lookups, whose text lives in sv.ts and is checked there.
    .replace(/\bt\(\s*"[^"]*"/g, "t(")
    .replace(TECHNICAL_ATTRIBUTES, " ");

  const found: CopyString[] = [];
  const add = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (isCopy(clean)) found.push({ text: clean, file: relative });
  };

  // Text between tags: `>Öppna appen<`. Braces are excluded so an interpolated
  // expression is never mistaken for words.
  for (const match of code.matchAll(/>([^<>{}]+)</g)) add(match[1] ?? "");

  // String values still standing: `alt="..."`, `label: "..."`, and the messages
  // a handler falls back to.
  for (const line of code.split("\n")) {
    if (TECHNICAL_KEYS.test(line)) continue;
    for (const match of line.matchAll(/"([^"\\]*)"/g)) add(match[1] ?? "");
  }

  return found;
}

/** Every component's copy, across the whole web app. */
export function allJsxStrings(): CopyString[] {
  return componentFiles().flatMap(jsxStrings);
}

/** The landing page alone, for the rules that apply only to it. */
export function landingStrings(): string[] {
  const file = path.join(WEB_SRC, "landing/Landing.tsx");
  return [...new Set(jsxStrings(file).map((entry) => entry.text))];
}

/**
 * Is this prose rather than machinery?
 *
 * The single-token exclusion is the one that does real work: identifiers, units,
 * slugs and class names are single tokens, and Swedish sentences are not. It
 * also means a one-word label goes unchecked, which is a gap this accepts —
 * a one-word label cannot contain a dashed clause, which is what these rules are
 * about.
 */
function isCopy(text: string): boolean {
  if (text.length < 3) return false;
  if (!/\p{L}/u.test(text)) return false;
  if (!text.includes(" ")) return false;
  // A class list, a MIME type, a path or a URL.
  if (/^[a-z0-9\s:/[\]().%#*_-]+$/.test(text)) return false;
  if (/https?:\/\//.test(text)) return false;
  return true;
}

/**
 * Single-character placeholders, which `isCopy` cannot see and which are the
 * other half of D101.
 *
 * A lone dash standing in for a value the app does not have is not punctuation,
 * so the dash rule misses it, and it is not prose, so nothing else looks at it.
 * §3 is explicit that absent is not zero and that the app says "inte än"; a dash
 * says nothing at all, in a place where the whole design is about saying what is
 * and is not known.
 */
export function dashPlaceholders(): CopyString[] {
  const found: CopyString[] = [];
  for (const file of componentFiles()) {
    const source = readFileSync(file, "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const relative = path.relative(WEB_SRC, file).replaceAll("\\", "/");

    for (const match of source.matchAll(/["'`]\s*[–—]\s*["'`]/g)) {
      found.push({ text: match[0], file: relative });
    }
    // `?? "—"` inside a template literal, which the pattern above also catches,
    // and a bare dash as a JSX child, which it does not.
    for (const match of source.matchAll(/>\s*[–—]\s*</g)) {
      found.push({ text: match[0], file: relative });
    }
  }
  return found;
}
