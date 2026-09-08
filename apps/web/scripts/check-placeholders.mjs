/**
 * Fails if one of *this project's* placeholders survives into `dist/` in a file
 * nothing will substitute.
 *
 *   node scripts/check-placeholders.mjs [dist dir]
 *
 * ## Why this exists
 *
 * The installed app on a phone was called `__APP_NAME__`. The build had done
 * exactly what it was told — `vite build` leaves the placeholder for nginx to
 * substitute at container start (D13) — and the dev server's substitution
 * middleware was still watching the path the manifest lived at before D90 moved
 * the app to `/app/`. Nothing broke loudly. A file was served with a placeholder
 * in it and the phone believed it.
 *
 * ## What it checks, and what it deliberately does not
 *
 * Not "are there placeholders in dist": there are, on purpose. The question is
 * whether each one is in a file something actually rewrites.
 * `infra/nginx/30-app-name.sh` rewrites `*.html`, `*.webmanifest` and `*.json`,
 * so a placeholder in one of those is the design working. A placeholder in a
 * JavaScript bundle, a stylesheet or an SVG is one nobody will ever fill.
 *
 * The tokens looked for are the ones **this repository writes**, discovered from
 * its own source rather than hard-coded, so a placeholder invented next year is
 * covered without anyone remembering this file. That also keeps third-party
 * conventions out of the results: `__PURE__`, `__WB_REVISION__` and
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` are not ours and are not findings.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const WEB = path.resolve(import.meta.dirname, "..");
const DIST = path.resolve(process.argv[2] ?? path.join(WEB, "dist"));

/** Exactly what `30-app-name.sh` passes to sed. Keep the two in step. */
const SUBSTITUTED = [".html", ".webmanifest", ".json"];

/** `__ANYTHING__`, the shape this project uses for a runtime substitution. */
const PLACEHOLDER = /__[A-Z][A-Z0-9_]*__/g;

/** Text files worth reading at all. A font or a PNG cannot hold one usefully. */
const TEXT = new Set([...SUBSTITUTED, ".js", ".mjs", ".cjs", ".css", ".svg", ".txt", ".xml"]);

/**
 * Placeholders that are allowed to compile into a bundle, with the reason.
 *
 * `app-name.ts` compares against the literal so the app can tell an
 * unsubstituted value from a real name and fall back rather than render
 * `__APP_NAME__` on screen. The string has to survive into the bundle for that
 * comparison to work, so its presence there is the feature.
 */
const ALLOWED_IN_CODE = new Map([
  ["__APP_NAME__", "src/lib/app-name.ts compares against it to detect a failed substitution"],
]);

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}

/** Every placeholder this repository writes, read out of the files it owns. */
function ourPlaceholders() {
  const roots = ["src", "public", "index.html", "app"].map((entry) => path.join(WEB, entry));
  const files = roots.flatMap((root) => {
    if (!existsSync(root)) return [];
    return statSync(root).isDirectory() ? walk(root) : [root];
  });

  const names = new Set();
  for (const file of files) {
    if (!TEXT.has(path.extname(file))) continue;
    for (const match of readFileSync(file, "utf8").match(PLACEHOLDER) ?? []) names.add(match);
  }
  return names;
}

const ours = ourPlaceholders();
if (ours.size === 0) {
  console.error("Found no placeholders in the source at all. Is this the right directory?");
  process.exit(1);
}
console.log(`this project's placeholders: ${[...ours].sort().join(", ")}`);

let unfilled = 0;
let expected = 0;

for (const file of walk(DIST)) {
  const extension = path.extname(file);
  if (!TEXT.has(extension)) continue;

  const found = [...new Set(readFileSync(file, "utf8").match(PLACEHOLDER) ?? [])].filter((name) =>
    ours.has(name),
  );
  if (found.length === 0) continue;

  const relative = path.relative(DIST, file).replaceAll("\\", "/");

  if (SUBSTITUTED.includes(extension)) {
    expected += 1;
    console.log(`  ok       ${relative}: ${found.join(", ")} (nginx substitutes this file)`);
    continue;
  }

  const unexplained = found.filter((name) => !ALLOWED_IN_CODE.has(name));
  if (unexplained.length === 0) {
    console.log(
      `  ok       ${relative}: ${found.map((n) => `${n} (${ALLOWED_IN_CODE.get(n)})`).join(", ")}`,
    );
    continue;
  }

  unfilled += 1;
  console.error(`  UNFILLED ${relative}: ${unexplained.join(", ")}`);
}

if (unfilled > 0) {
  console.error(
    `\n${unfilled} file(s) carry a placeholder nothing will substitute.` +
      `\nEither fill it at build time, or move the value into a file` +
      ` 30-app-name.sh rewrites (${SUBSTITUTED.join(", ")}).`,
  );
  process.exit(1);
}

console.log(`\nplaceholders: ${expected} file(s) for nginx, none left unfilled.`);
