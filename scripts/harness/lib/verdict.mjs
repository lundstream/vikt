/**
 * A harness run's verdict lives in a file, not in its output (CLAUDE.md §7).
 *
 * Every check is appended to `verdict.txt` beside whatever the run produced, as
 * it is made; the exit code is computed by reading that file back. A sweep
 * once produced all its screenshots and none of its verdict lines because its
 * stdout was piped, and a run that dies half way leaves what it established.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function verdict(outDir, heading) {
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "verdict.txt");
  writeFileSync(file, `${heading} ${new Date().toISOString()}\n`);

  const record = (line) => {
    appendFileSync(file, line + "\n");
    console.log(line);
  };

  return {
    file,
    record,
    /** One named check: `ok  ` or `FAIL`, and what was seen. */
    check(label, passed, detail = "") {
      record(`${passed ? "ok  " : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
      return passed;
    },
    /**
     * The summary line, from the file. `expected` is how many `ok`/`FAIL`
     * lines a complete run writes, when the run knows. Sets `process.exitCode`,
     * never `process.exit()`, so nothing unflushed is lost.
     */
    finish(expected = null) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const checks = lines.filter((line) => /^(ok {2}|FAIL) /.test(line));
      const failed = checks.filter((line) => line.startsWith("FAIL"));
      const complete = expected === null || checks.length === expected;
      const summary =
        `summary checks=${checks.length}${expected === null ? "" : `/${expected}`} ` +
        `failed=${failed.length} complete=${complete}`;
      appendFileSync(file, summary + "\n");
      console.log(summary);
      for (const line of failed) console.log("  " + line);
      process.exitCode = failed.length === 0 && complete ? 0 : 1;
      return { failed: failed.length, complete };
    },
  };
}
