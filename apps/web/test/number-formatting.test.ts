import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * No number reaches the screen without the shared formatter (D26).
 *
 * This exists because the celebration screen rendered **`Vid 87.27`** — a full
 * stop and two decimals, in a Swedish interface, on the one screen someone
 * actually stops and reads. The line was `String(milestone.achievedValue)`.
 * Every test passed, because tests assert values and this was about the path
 * taken to produce one.
 *
 * **This is a type-level guard, not a grep.** The brief allowed grep as a
 * fallback; it turned out not to be needed, and the difference matters. Grep
 * can find `.toFixed(` and `String(`, but the actual defect class is a *number
 * interpolated into JSX*, which has no syntactic marker at all: `{value}`
 * renders `87.27` when `value` is a number and is perfectly correct when it is
 * a formatted string. Only the type tells them apart, so the check asks the
 * TypeScript program for the type of every JSX interpolation and flags the ones
 * that are numeric.
 *
 * Two escape hatches, both narrow:
 *
 *  - a `data-` attribute or a `key`, which are not read by a person;
 *  - an explicit `allow-raw-number: <reason>` comment just above, which has to
 *    say why. There is exactly one: the 1-5 digit on a rating button, where a
 *    single digit has no separator or decimal for a formatter to place.
 *
 * ## Dates are the same defect with a different type (D179)
 *
 * The weekly review card rendered **"Veckan från 2026-09-07"**. An ISO date is
 * how a day is stored and `formatLongDay` is how every other date on every other
 * screen is written, so this is `String(milestone.achievedValue)` again with the
 * type changed: the value is a `string`, so nothing above it can see it.
 *
 * What separates the two is the **name**. A field called `weekStart` or
 * `localDate` holds `YYYY-MM-DD` throughout this codebase, so an interpolation
 * of one straight into rendered text is the defect, and putting it through one
 * of the date formatters in `lib/dates.ts` is the fix. The hatch is
 * `allow-raw-date: <reason>`, for the places where the ISO string is the point.
 */

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(WEB, "src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry)) found.push(full);
  }
  return found;
}

const files = sourceFiles(SRC);

const program = ts.createProgram(files, {
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

/**
 * True when a value can *only* be a number.
 *
 * Deliberately "only", not "possibly". `ReactNode` is a union that happens to
 * include `number`, so a "possibly" rule flags every `{children}` in the app,
 * and a guard that cries wolf on ordinary code is a guard someone deletes.
 * `number | null` still counts: that is a number when it is present.
 */
function isNumeric(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.NumberLike) return true;

  if (type.isUnion()) {
    const meaningful = type.types.filter(
      (member) => !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
    );
    return meaningful.length > 0 && meaningful.every((member) => isNumeric(member));
  }

  return false;
}

type Finding = { file: string; line: number; text: string };

function findRawNumbers(): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const text = source.getFullText();

    const visit = (node: ts.Node): void => {
      if (ts.isJsxExpression(node) && node.expression) {
        // An interpolation inside an attribute is not read by a person.
        const inAttribute = ts.isJsxAttribute(node.parent);
        if (!inAttribute) {
          const type = checker.getTypeAtLocation(node.expression);

          if (isNumeric(type)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            // Look back a few lines: the exemption is a JSX comment, and a
            // comment long enough to state a reason wraps onto two.
            const preceding = text.split("\n").slice(Math.max(0, line - 3), line);

            if (!preceding.some((row) => row.includes("allow-raw-number:"))) {
              findings.push({
                file: path.relative(SRC, file),
                line: line + 1,
                text: node.getText(source).slice(0, 60),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return findings;
}

/**
 * Two decimals have to say why (D176).
 *
 * "↓ 4,98 kg på 90 dagar" sat under a trend weight rendered as "86,9", on the
 * same card, in a screenshot somebody sent in. §4.1 is explicit that a weight is
 * one decimal, and the second one claims a precision neither the scale nor the
 * EMA has.
 *
 * A grep for `decimals: 2` is not enough on its own, because two of them are
 * right: a rate in kg per week distinguishes 0,25 from 0,30, and waist over
 * height lives between 0,40 and 0,60. So the rule is the one this file already
 * uses for raw numbers: the exception is allowed and has to be written down,
 * with `allow-two-decimals:` and a reason, on a line above the call.
 *
 * A weight cannot be justified that way, and the failure message says so.
 */
function twoDecimalCalls(): string[] {
  const findings: string[] = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    /*
      Comments blanked, newlines kept, so line numbers still point at code.
      Without this the guard finds the sentence in the comment that explains
      the defect it was written for, which is what happened on the first run.
    */
    const original = source.getFullText();
    const text = original.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) =>
      comment.replace(/[^\n]/g, " "),
    );
    // The hatch is itself a comment, so it is read from the original lines
    // while the search runs over the blanked ones.
    const lines = original.split("\n");

    for (const match of text.matchAll(/decimals:\s*2\b/g)) {
      const line = text.slice(0, match.index).split("\n").length - 1;
      const preceding = lines.slice(Math.max(0, line - 3), line);
      if (preceding.some((row) => row.includes("allow-two-decimals:"))) continue;
      findings.push(`${path.relative(SRC, file)}:${line + 1}`);
    }
  }

  return findings;
}

describe("two decimals", () => {
  it("is only written where a line above says why", () => {
    expect(
      twoDecimalCalls(),
      "a weight is one decimal (§4.1); a rate or a ratio needs an allow-two-decimals comment",
    ).toEqual([]);
  });

  /** Proved by reintroduction: the guard has to see the shape it is looking for. */
  it("is what this guard is looking for", () => {
    const offending = 'formatDecimal(Math.abs(change), { decimals: 2 })';
    expect(/decimals:\s*2\b/.test(offending)).toBe(true);
    expect(/decimals:\s*1\b/.test('formatKg(Math.abs(change))')).toBe(false);
  });
});

/** The formatters in `lib/dates.ts`, which are what a date has to go through. */
const DATE_FORMATTERS = ["formatLongDay", "formatDayMonth", "describeDay", "formatMonthYear"];

/**
 * Fields that hold `YYYY-MM-DD` in this codebase.
 *
 * Named rather than inferred, because the type is `string` and a `string` is
 * not a date to a compiler. The list is short **and it has to stay short**: the
 * first draft included `day`, `from` and `to`, which caught sixteen call sites
 * that were already correct, because those names carry a value somebody has
 * formatted a few lines earlier. One of them was an email address.
 *
 * These five are names the schemas and repositories use for a stored day, and
 * nothing else in this tree uses them for anything else.
 */
const DATE_NAMES = /^(localDate|weekStart|weekEnd|achievedAt|startedAt)$/;

function findRawDates(): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const text = source.getFullText();

    /** Is this expression already inside a call to a date formatter? */
    const formatted = (node: ts.Node): boolean => {
      for (let at: ts.Node | undefined = node; at; at = at.parent) {
        if (ts.isCallExpression(at)) {
          const called = at.expression.getText(source);
          if (DATE_FORMATTERS.some((name) => called.endsWith(name))) return true;
        }
        if (ts.isJsxExpression(at) && at !== node) break;
      }
      return false;
    };

    const visit = (node: ts.Node): void => {
      /*
        The last segment of the name, whether it is `weekStart`,
        `review.data.weekStart` or `{ date: weekStart }`. A bare identifier and
        a property access are the same mistake.
      */
      const named =
        ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
          ? (ts.isPropertyAccessExpression(node) ? node.name.text : node.text)
          : null;

      if (named !== null && DATE_NAMES.test(named) && !formatted(node)) {
        /* Only where it reaches a person: rendered text, or a value handed to
           the dictionary, which puts it into rendered text. */
        const inJsxText =
          ts.isJsxExpression(node.parent) && !ts.isJsxAttribute(node.parent.parent);
        const inTranslation =
          ts.isPropertyAssignment(node.parent) &&
          ts.isObjectLiteralExpression(node.parent.parent) &&
          ts.isCallExpression(node.parent.parent.parent) &&
          /(^|\.)t$/.test(node.parent.parent.parent.expression.getText(source));

        if (inJsxText || inTranslation) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          const preceding = text.split("\n").slice(Math.max(0, line - 4), line);
          if (!preceding.some((row) => row.includes("allow-raw-date:"))) {
            findings.push({
              file: path.relative(SRC, file),
              line: line + 1,
              text: node.getText(source).slice(0, 60),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return findings;
}

describe("dates on screen", () => {
  it("never renders an ISO date", () => {
    const findings = findRawDates().map(
      (finding) => `${finding.file}:${finding.line} {${finding.text}}`,
    );

    expect(
      findings,
      "a date goes through lib/dates.ts, or carries an allow-raw-date comment saying why not",
    ).toEqual([]);
  });

  /**
   * Proof by reintroduction: the check has to catch the shape that caused it to
   * be written, and leave the fixed shape alone.
   */
  it("would have caught the review card's week", () => {
    const before = 't("coach.weekOf", { date: review.data.weekStart })';
    const after = 't("coach.weekOf", { date: formatLongDay(review.data.weekStart, LOCALE) })';

    const probe = (body: string) =>
      ts.createSourceFile("probe.tsx", `const x = ${body};`, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);

    const names: string[] = [];
    const walk = (node: ts.Node, formattedAbove: boolean): void => {
      const isFormatter =
        ts.isCallExpression(node) &&
        DATE_FORMATTERS.some((name) => node.expression.getText().endsWith(name));
      if (ts.isPropertyAccessExpression(node) && DATE_NAMES.test(node.name.text) && !formattedAbove) {
        names.push(node.name.text);
      }
      ts.forEachChild(node, (child) => walk(child, formattedAbove || isFormatter));
    };

    walk(probe(before), false);
    expect(names).toEqual(["weekStart"]);

    names.length = 0;
    walk(probe(after), false);
    expect(names).toEqual([]);
  });
});

describe("numbers on screen", () => {
  it("has a working TypeScript program, so the check is not vacuous", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(program.getSourceFile(files[0]!)).toBeDefined();
  });

  it("resolves types rather than silently seeing `any` everywhere", () => {
    // If module resolution failed, every type would be `any` and the check
    // would pass by accident. Prove the checker knows a real numeric type.
    const source = program.getSourceFiles().find((f) => f.fileName.endsWith("Progress.tsx"));
    expect(source).toBeDefined();

    let sawNumber = false;
    const visit = (node: ts.Node): void => {
      if (ts.isNumericLiteral(node)) {
        if (isNumeric(checker.getTypeAtLocation(node))) sawNumber = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source!);

    expect(sawNumber).toBe(true);
  });

  it("never interpolates a bare number into rendered output", () => {
    const findings = findRawNumbers().map(
      (finding) => `${finding.file}:${finding.line} {${finding.text}}`,
    );

    expect(findings).toEqual([]);
  });

  /**
   * Proof by reintroduction. The check has to actually catch the shape that
   * caused it to be written, or it is decoration.
   */
  it("would have caught a raw number in JSX", () => {
    const probe = ts.createSourceFile(
      "probe.tsx",
      `export function P({ value }: { value: number }) { return <p>{value}</p>; }`,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TSX,
    );

    let found = false;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        // The standalone probe has no program, so read the annotation directly.
        if (node.expression.getText(probe) === "value") found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);

    expect(found).toBe(true);
  });
});
