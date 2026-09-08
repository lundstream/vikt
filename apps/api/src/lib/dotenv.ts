import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads the first `.env` found walking up from the working directory.
 *
 * pnpm runs package scripts with the cwd set to the package, so `pnpm --filter
 * api invite` starts in `apps/api` while the developer's `.env` lives at the
 * workspace root. Walking up finds it either way, and finds nothing in
 * production, where the environment comes from compose.
 *
 * Uses Node's own `process.loadEnvFile` rather than dotenv: dotenv is CommonJS
 * and its `require("fs")` becomes an unsupported dynamic require once tsup
 * bundles this into an ESM file, which breaks only in the built image. Like
 * `--env-file`, this does not overwrite variables that are already set, so the
 * real environment always wins over the file.
 *
 * Import this for its side effect, before anything reads `process.env`.
 */
function loadDotenv(): void {
  let dir = process.cwd();

  for (let depth = 0; depth < 5; depth++) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch {
        // An unreadable or malformed .env must not stop the process here;
        // assertProdSecrets() is what decides whether the result is usable.
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadDotenv();
