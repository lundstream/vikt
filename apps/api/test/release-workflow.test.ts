import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The release workflow builds what it proves, and runs once (D169).
 *
 * `gh release create` pushes a tag and publishes a release on the same commit.
 * With a `branches: ["main"]` trigger beside the tag one, that started a second
 * run for the branch, and **the branch run failed every time**: a build with no
 * tag reports its version as `dev`, and the step that proves the image is
 * anonymously pullable then asked GHCR for a tag named `dev`, which nothing
 * pushes. `anonymous manifest fetch for lundstream/vikt-web:dev returned 404`,
 * on every release, next to a green tag run of the same commit.
 *
 * That is worse than an ordinary broken check: it teaches whoever cuts the
 * release that a red release workflow is normal. So the trigger is tags,
 * releases and a manual run, and the proof asks about `sha-<commit>`, which
 * every run publishes whatever started it.
 *
 * Read as text rather than parsed as YAML. The file is small, these are claims
 * about lines somebody can find, and the api package has no YAML parser.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKFLOW = path.join(ROOT, ".github/workflows/release.yml");
const text = readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");

/**
 * The `on:` block, up to the next top-level key, with its comments stripped.
 *
 * Stripped because the comments explain what is deliberately **absent**, and a
 * check for an absent key would otherwise be failed by the paragraph saying why
 * it is absent.
 */
const trigger = (() => {
  const start = text.indexOf("\non:\n");
  expect(start, "the workflow has no on: block").toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n[a-z][a-z0-9_-]*:/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  return block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
})();

describe("the release workflow's triggers", () => {
  it("builds on a version tag", () => {
    expect(trigger).toMatch(/tags:\s*\["v\*\.\*\.\*"\]/);
  });

  it("builds on a published release, which is how the runbook cuts a version", () => {
    expect(trigger).toMatch(/release:\n\s*types:\s*\[published\]/);
  });

  it("does not also build on a branch push, which would run twice and fail once", () => {
    expect(trigger, "a branches: trigger is back; see D169").not.toMatch(/^\s*branches:/m);
  });

  /**
   * The filter only ever applied to the branch trigger. A tag adds no commits
   * for a path filter to look at, so leaving it behind would be a line that
   * reads like a rule and is not one.
   */
  it("carries no paths-ignore, which never applied to tags", () => {
    expect(trigger).not.toMatch(/paths-ignore/);
  });
});

describe("the anonymous-pull proof", () => {
  it("asks about a tag every run actually publishes", () => {
    expect(text).toMatch(/tag="sha-\$\{\{ github\.sha \}\}"/);
  });

  it("does not ask about the version, which is `dev` outside a release", () => {
    const proof = text.slice(text.indexOf("Prove the package is anonymously pullable"));
    expect(proof).not.toMatch(/tag='\$\{\{ steps\.version\.outputs\.value \}\}'/);
  });

  /** And the tag it proves is one the metadata step is told to produce. */
  it("proves a tag the metadata step produces", () => {
    expect(text).toMatch(/type=sha,format=long/);
  });
});

describe("the `latest` tag", () => {
  /**
   * `enable={{is_default_branch}}` can never be true again now that no branch
   * push starts this workflow, so `latest` would silently stop existing.
   */
  it("follows releases rather than the default branch", () => {
    expect(text).not.toMatch(/value=latest,enable=\{\{is_default_branch\}\}/);
    expect(text).toMatch(
      /value=latest,enable=\$\{\{ github\.ref_type == 'tag' \|\| github\.event_name == 'release' \}\}/,
    );
  });
});
