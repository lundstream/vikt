/**
 * What the landing page costs a stranger, asserted (D173).
 *
 *   node scripts/check-bundle.mjs [dist dir]
 *
 * Measures **everything `/` loads**: the entry module plus every chunk the HTML
 * preloads, gzipped, which is what crosses the network. Not the landing chunk
 * on its own, which would pass while the page dragged a framework in beside it.
 *
 * ## The budget, and the number that is not met
 *
 * The brief for this rebuild asked for **under 40 kB of JavaScript gzipped**.
 * The page does not meet it, and the reason is worth writing down rather than
 * rounding off:
 *
 *   landing chunk   12 kB   the page itself, its motion and its fixture
 *   vendor chunk    47 kB   react + react-dom
 *
 * React alone is more than the whole budget. Nothing in the page's own code can
 * close that gap; what would is **not shipping React for this page at all**:
 * prerender the three static public pages to HTML at build time and load React
 * only for `/kod`, which is the one that has a form. That is a build-pipeline
 * change rather than a page change, and it is written up in D173 as the next
 * step rather than done in the same pass as the page.
 *
 * So the budget here is the honest one: the page may not get heavier than it is
 * now, by more than a rounding margin, and the target it is being held to
 * eventually is in the message when it fails.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const WEB = path.resolve(import.meta.dirname, "..");
const DIST = path.resolve(process.argv[2] ?? path.join(WEB, "dist"));

/**
 * Two numbers, because they answer different questions (D177).
 *
 * **The landing's own code**, 15 kB: everything this page's authors write. It
 * is the number that moves when a section is added, and the one that says
 * whether the page is getting heavy.
 *
 * **Everything `/` fetches**, 60 kB: what a stranger on a phone actually pays.
 * Most of it is react and react-dom, which is a decision (D173's addendum)
 * rather than a number anybody can work down by editing the page.
 *
 * Holding only the total would let the page's own code triple while the total
 * stayed flat; holding only the page's code would let a dependency arrive
 * unnoticed. Neither alone is the budget.
 */
const OWN_BUDGET = 15 * 1024;
const TOTAL_BUDGET = 60 * 1024;

const html = path.join(DIST, "index.html");
if (!existsSync(html)) {
  process.stderr.write(`no build at ${DIST}. Run \`pnpm --filter web build\` first.\n`);
  process.exit(1);
}

const source = readFileSync(html, "utf8");

/** The entry module and every chunk the HTML tells the browser to fetch early. */
const references = [
  ...source.matchAll(/<script[^>]+src="([^"]+\.js)"/g),
  ...source.matchAll(/rel="modulepreload"[^>]*href="([^"]+\.js)"/g),
].map((match) => match[1]);

if (references.length === 0) {
  process.stderr.write("index.html references no JavaScript at all, which cannot be right.\n");
  process.exit(1);
}

let total = 0;
let own = 0;
const rows = [];
for (const reference of new Set(references)) {
  const file = path.join(DIST, reference.replace(/^\//, ""));
  const gzipped = gzipSync(readFileSync(file), { level: 9 }).length;
  total += gzipped;
  // The entry chunk is this page's own code; everything preloaded beside it is
  // the vendor code it depends on.
  const mine = /landing-[^/]*\.js$/.test(reference);
  if (mine) own += gzipped;
  rows.push(`  ${reference.padEnd(40)} ${(gzipped / 1024).toFixed(1)} kB${mine ? "  (the page's own)" : ""}`);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

process.stdout.write(`the landing page loads ${kb(total)} of JavaScript, gzipped:\n`);
for (const row of rows) process.stdout.write(`${row}\n`);
process.stdout.write(`  ${"its own code".padEnd(40)} ${kb(own)}\n`);

const failures = [];
if (own > OWN_BUDGET) {
  failures.push(`the page's own code is ${kb(own)}, over its ${kb(OWN_BUDGET)} budget`);
}
if (total > TOTAL_BUDGET) {
  failures.push(`the page loads ${kb(total)} in total, over its ${kb(TOTAL_BUDGET)} budget`);
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`\nover budget: ${failure}.\n`);
  process.stderr.write(
    "React on the public pages is a decision, not an accident (D173 addendum).\n" +
      "If the total is what grew, look at what was imported rather than at the copy.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `within budget: own ${kb(own)} of ${kb(OWN_BUDGET)}, total ${kb(total)} of ${kb(TOTAL_BUDGET)}.\n`,
);
