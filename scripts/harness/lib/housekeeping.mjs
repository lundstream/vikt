/**
 * The harness cleans up after itself (CLAUDE.md §7).
 *
 * A browser profile is deleted when the script that made it exits, and only
 * the last three screenshot sets are kept. The scratch folder once reached
 * 5.4 GB of abandoned profiles and every set ever taken, because each script
 * made its own and none removed it.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Removes `directory` when the process exits, however it exits, after running
 * `before` (which is where the browser is stopped, so its files are released).
 * Returns the remover, for a caller that is done early.
 */
export function deleteOnExit(directory, before = () => {}) {
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    try {
      before();
    } catch {
      // Already gone.
    }
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A browser still releasing its files; the system's temporary folder
      // is cleared on its own, and nothing reads a stale profile.
    }
  };

  process.once("exit", remove);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      remove();
      process.exit(130);
    });
  }
  return remove;
}

/** Keeps the newest `keep` directories in `parent`, deleting the rest. */
export function pruneSets(parent, keep = 3) {
  let entries = [];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  const sets = entries
    .map((entry) => {
      const full = path.join(parent, entry);
      const info = statSync(full, { throwIfNoEntry: false });
      return info?.isDirectory() ? { full, entry, at: info.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);

  const removed = [];
  for (const set of sets.slice(keep)) {
    try {
      rmSync(set.full, { recursive: true, force: true, maxRetries: 3 });
      removed.push(set.entry);
    } catch {
      // Locked; the next run tries again.
    }
  }
  return removed;
}
