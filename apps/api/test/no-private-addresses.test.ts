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
 * The one private range allowed, and why: `edge`, the product's own Docker
 * bridge network, pinned in both compose files so `TRUST_PROXY` can name the
 * proxy's subnet (D14). It is configuration every installation gets, not an
 * address on anybody's network, and the trust-proxy tests use addresses inside
 * it because that is what they are about.
 */
const ALLOWED = /^172\.31\.240\.\d{1,3}$/;

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
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(PRIVATE)) {
        if (!ALLOWED.test(match[0])) hits.push(`${file}:${index + 1} ${match[0]}`);
      }
    }
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

  it("are in no tracked file", () => {
    // Joined, so the failure lists every file and line rather than a count.
    expect(privateAddresses().join("\n"), "a tracked file holds a private address").toBe("");
  });
});
