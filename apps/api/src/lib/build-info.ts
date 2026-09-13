/**
 * Which build this is (D151).
 *
 * Deliberately **not** part of the environment schema, and the distinction is
 * the point. Everything in `env.ts` is a choice an operator makes: a host, a
 * key, a mode. These two are facts about the binary, baked in at build time by
 * `release.yml` from the tag and the commit it built. Forwarding them as stack
 * variables would let a deployment claim to be a version it is not, which is
 * worse than not saying, because the whole reason to print a version is to be
 * able to trust the answer when something is wrong.
 *
 * They arrive as `ARG` in `infra/api.Dockerfile`, become `ENV` in the runtime
 * stage, and are read here once.
 *
 * A tree that is not a release says so. `dev` is not a version anybody could
 * mistake for one, and it is what a local `pnpm dev` and an untagged `main`
 * build both report; the commit is what tells those apart.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = {
  /** The tag this was built from, or `dev`. Never empty. */
  version: string;
  /** The full commit sha, or empty where the build had none to give. */
  commit: string;
  /** The first seven characters, which is what anybody reads. */
  shortCommit: string;
  /** One line: `1.1.0 (a1b2c3d)`, or `dev` where there is no commit either. */
  label: string;
};

/**
 * The checked-out commit, for a development run that was never built.
 *
 * Read from `.git` rather than by spawning git: this is called on a public
 * endpoint, a subprocess per request is not a thing to add for a footer, and
 * the two files are a few bytes each. A container has no `.git` at all, which
 * is the correct answer there — the build argument is what speaks for an image.
 *
 * Memoised, because a checkout does not change commit while the process runs,
 * and if it does the next restart says so.
 */
let fromCheckout: string | null = null;

function checkoutCommit(): string {
  if (fromCheckout !== null) return fromCheckout;
  fromCheckout = "";

  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    const head = readFileSync(path.join(root, ".git/HEAD"), "utf8").trim();

    if (!head.startsWith("ref:")) {
      fromCheckout = /^[0-9a-f]{40}$/.test(head) ? head : "";
      return fromCheckout;
    }

    const ref = head.slice(4).trim();
    const sha = readFileSync(path.join(root, ".git", ref), "utf8").trim();
    fromCheckout = /^[0-9a-f]{40}$/.test(sha) ? sha : "";
  } catch {
    // No checkout, or a packed ref this is not going to chase. Absent is fine.
  }

  return fromCheckout;
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const version = env.APP_VERSION?.trim() || "dev";
  /**
   * The build argument first, always. Only a run with none falls back to the
   * checkout, which is what makes `pnpm dev` say `dev (a1b2c3d)` rather than
   * just `dev` while an image still says exactly what was baked into it.
   */
  const baked = env.APP_COMMIT?.trim() ?? "";
  const commit = baked !== "" ? baked : checkoutCommit();
  const shortCommit = commit.slice(0, 7);

  return {
    version,
    commit,
    shortCommit,
    label: shortCommit === "" ? version : `${version} (${shortCommit})`,
  };
}
