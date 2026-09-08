import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The math lives in `packages/shared/src/calc/` so the server and the client
 * compute identical numbers — CLAUDE.md §2, "No duplicated formulas".
 *
 * That rule is easy to break by accident. Rounding a projection here, adjusting
 * a confidence figure there, and a fortnight later the dashboard and the API
 * disagree about the same user's maintenance calories with no test failing,
 * because each side is internally consistent. So this checks the *source* for
 * the physiological constants rather than checking a computed value.
 *
 * If you need one of these numbers in the UI, import it from `shared`.
 */

const WEB_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

/** Constants that only ever belong in `packages/shared/src/calc/`. */
const FORBIDDEN_CONSTANTS: { pattern: RegExp; what: string }[] = [
  { pattern: /\b7700\b/, what: "the kcal-per-kg approximation (import KCAL_PER_KG)" },
  { pattern: /\b6\.25\b/, what: "a Mifflin-St Jeor coefficient" },
  { pattern: /\b161\b/, what: "the Mifflin-St Jeor female offset" },
  { pattern: /\b0\.8[^0-9]/, what: "the coverage gate (import COVERAGE_GATE)" },
];

/** Function names that would mean the client had grown its own copy. */
const FORBIDDEN_DEFINITIONS =
  /\bfunction\s+(computeTrend|estimateTdee|mifflinStJeor|projectOnPlan|projectAtCurrentPace|leastSquares|adaptiveConfidence|buildIntakeIndex)\b/;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

/** Strips comments, so prose explaining 7700 kcal/kg is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = sourceFiles(WEB_SRC);

describe("the web app does not reimplement the shared math", () => {
  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_CONSTANTS)(
    "does not hardcode $what anywhere in src/",
    ({ pattern }) => {
      const offenders = files.filter((file) =>
        pattern.test(stripComments(readFileSync(file, "utf8"))),
      );
      expect(offenders.map((file) => path.relative(WEB_SRC, file))).toEqual([]);
    },
  );

  it("does not define its own copy of any calc function", () => {
    const offenders = files.filter((file) =>
      FORBIDDEN_DEFINITIONS.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders.map((file) => path.relative(WEB_SRC, file))).toEqual([]);
  });
});

describe("the dashboard gets its numbers from shared", () => {
  const dashboard = readFileSync(path.join(WEB_SRC, "routes/Dashboard.tsx"), "utf8");

  it("imports the trend calculation rather than smoothing locally", () => {
    expect(dashboard).toMatch(/import\s*{[^}]*computeTrend[^}]*}\s*from\s*"shared"/s);
  });

  it("does not contain an EMA of its own", () => {
    // The shape of `trend + alpha * (raw - trend)`, however it is spelled.
    expect(stripComments(dashboard)).not.toMatch(/alpha\s*\*/);
  });

  it("renders maintenance and projections from the server's computed values", () => {
    const panel = readFileSync(path.join(WEB_SRC, "components/InsightsPanel.tsx"), "utf8");
    // It reads the fields; it does not derive them.
    expect(panel).toMatch(/maintenance\.(tdee|source|confidence)/);
    expect(panel).toMatch(/projections\.(onPlan|atCurrentPace)/);
    expect(stripComments(panel)).not.toMatch(/estimateTdee\s*\(|projectOnPlan\s*\(/);
  });
});
