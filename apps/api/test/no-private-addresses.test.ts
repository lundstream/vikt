import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No tracked file holds a private network address (CLAUDE.md §7).
 *
 * The repository is public, and an RFC 1918 address in it is most likely the
 * owner's: the Portainer host, the Docker host, the workstation. Those live in
 * INFRA.md, which is not tracked, and a script that needs one reads it from the
 * environment by name. Tests and examples use RFC 5737's documentation ranges,
 * which route nowhere by definition.
 *
 * Every file `git ls-files` lists is read, binaries skipped, and a hit is named
 * by file and line so the failure says where to look.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const PRIVATE = new RegExp(
  String.raw`(?<![\d.])(?:10\.${OCTET}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.${OCTET}\.${OCTET}(?![\d])`,
  "g",
);

/**
 * The one private range allowed, and only where it is defined (D197): `edge`,
 * the product's own Docker bridge network, pinned in both compose files so
 * `TRUST_PROXY` can name the proxy's subnet, and documented in D14. Anywhere
 * else, a test, an example, a message or a report, it fails like any other
 * private address; those say "the edge subnet" or use a documentation range.
 */
const EDGE = /^172\.31\.240\.\d{1,3}$/;
const EDGE_FILES = new Set([
  "infra/docker-compose.yml",
  "infra/docker-compose.portainer.yml",
  "DECISIONS.md",
]);

/** The private addresses one file's text may not hold, as "file:line address". */
function offending(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(PRIVATE)) {
      if (EDGE.test(match[0]) && EDGE_FILES.has(file)) continue;
      hits.push(`${file}:${index + 1} ${match[0]}`);
    }
  }
  return hits;
}

/** Every tracked text file's private addresses, as "file:line address". */
function privateAddresses(): string[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const hits: string[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(ROOT, file));
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    hits.push(...offending(file, bytes.toString("utf8")));
  }
  return hits;
}

describe("private network addresses", () => {
  it("finds one where there is one, and none in a documentation range", () => {
    // Assembled from parts, so this file does not hold what it looks for.
    const at = (...octets: number[]) => octets.join(".");
    const sample = [
      `http://${at(192, 168, 1, 20)}:9000`,
      `deploy@${at(10, 0, 0, 7)}`,
      at(172, 16, 4, 2),
      at(172, 31, 255, 1),
      at(192, 0, 2, 20),
      at(198, 51, 100, 7),
      at(203, 0, 113, 9),
      at(172, 15, 0, 1),
      at(172, 32, 0, 1),
      `version ${at(110, 4, 1, 2)}`,
    ].join("\n");
    expect(sample.match(PRIVATE)).toEqual([
      at(192, 168, 1, 20),
      at(10, 0, 0, 7),
      at(172, 16, 4, 2),
      at(172, 31, 255, 1),
    ]);
  });

  /** Approved for the files that define it, and nowhere else (D197). */
  it("allows the edge subnet only where it is defined", () => {
    const edge = [172, 31, 240, 0].join(".") + "/24";
    expect(offending("infra/docker-compose.yml", `subnet: ${edge}`)).toEqual([]);
    expect(offending("DECISIONS.md", `the pinned subnet, ${edge}`)).toEqual([]);
    expect(offending("apps/api/test/trust-proxy.test.ts", `compile("${edge}")`)).toHaveLength(1);
    expect(offending("CLAUDE.md", edge)).toHaveLength(1);
    expect(offending("infra/.env.example", `TRUST_PROXY=${edge}`)).toHaveLength(1);
  });

  it("are in no tracked file", () => {
    // Joined, so the failure lists every file and line rather than a count.
    expect(privateAddresses().join("\n"), "a tracked file holds a private address").toBe("");
  });
});
