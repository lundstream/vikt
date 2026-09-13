/**
 * Fails when a test was skipped anywhere it is not allowed to be.
 *
 * ## Why this exists
 *
 * STATE.md said "in CI the api suite runs 711 with none skipped" for weeks.
 * Nothing checked it: the line was a person reading a CI log, and a line like
 * that goes stale the first time somebody marks a test `.skip` to get a branch
 * green. A skipped test is not a failing test, which is the whole problem — it
 * is silence, and silence is what this project has been caught by twice (the
 * SMB suite that never reached authentication, the S3 tests that had never run
 * at all until CI ran them).
 *
 * ## What it allows
 *
 * Exactly one file: `backup-s3-live.test.ts`, which needs a real S3 server and
 * `pg_dump` and therefore skips on a workstation. It is allowed to skip **only
 * where it is not configured to run**: in CI, where `S3_TEST_ENDPOINT` is set,
 * this script requires it to have run like everything else, so a runner that
 * lost MinIO fails instead of quietly covering less.
 *
 * Nothing else, and `todo` counts as a skip. A test somebody meant to write is
 * a note in a file, not a green tick.
 *
 * ## How it reads the run
 *
 * Each package writes a JSON report beside its own tests as part of `pnpm test`.
 * A missing report is a **failure**, not an empty pass: a guard that reads no
 * files finds no problems, which is precisely how this whole class of thing
 * stops working.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The three suites, and where each leaves its report. */
const REPORTS = [
  "packages/shared/.vitest-report.json",
  "apps/web/.vitest-report.json",
  "apps/api/.vitest-report.json",
];

/**
 * Files whose tests may skip, and why.
 *
 * One entry. Adding a second is a decision about coverage, which is why it is a
 * literal in a guard rather than a pattern somebody can widen by accident.
 */
const MAY_SKIP = new Set(["apps/api/test/backup-s3-live.test.ts"]);

/** True where the live S3 suite is configured, so it must not skip either. */
const s3Configured = (process.env.S3_TEST_ENDPOINT ?? "") !== "";

const missing = [];
const skipped = [];
let total = 0;

for (const relative of REPORTS) {
  const file = path.join(root, relative);
  if (!existsSync(file)) {
    missing.push(relative);
    continue;
  }

  const report = JSON.parse(readFileSync(file, "utf8"));

  for (const suite of report.testResults ?? []) {
    // Vitest reports the absolute path of the file the tests came from.
    const from = path.relative(root, suite.name).replaceAll("\\", "/");

    for (const test of suite.assertionResults ?? []) {
      total += 1;
      /**
       * Three spellings, because the reporter uses more than one and a guard
       * that knows only the first is a guard that passes. Verified against a
       * real report: `.skip` comes back as `skipped`, `.todo` as `todo`, and
       * `pending` is what older reporters called the first of those.
       */
      if (!["skipped", "pending", "todo"].includes(test.status)) continue;

      const allowed = MAY_SKIP.has(from) && !s3Configured;
      if (allowed) continue;

      skipped.push(`${from} :: ${test.fullName ?? test.title} (${test.status})`);
    }
  }
}

if (missing.length > 0) {
  console.error("No test report from:");
  for (const file of missing) console.error(`  ${file}`);
  console.error("\nThe suites have to run before this can check them.");
  process.exit(1);
}

if (total === 0) {
  console.error("The reports contain no tests at all, so this guard proved nothing.");
  process.exit(1);
}

if (skipped.length > 0) {
  console.error(`${skipped.length} test(s) skipped where skipping is not allowed:`);
  for (const line of skipped) console.error(`  ${line}`);
  console.error(
    "\nOnly apps/api/test/backup-s3-live.test.ts may skip, and only where " +
      "S3_TEST_ENDPOINT is unset. See CLAUDE.md §7.",
  );
  process.exit(1);
}

console.log(
  `${total} tests reported, none skipped outside the allowlist` +
    (s3Configured ? " (the live S3 suite ran)" : " (the live S3 suite skipped, as configured)"),
);
