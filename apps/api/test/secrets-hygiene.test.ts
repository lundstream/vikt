import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Credentials come from the environment, and nothing asks for one (D158).
 *
 * The rule in CLAUDE.md §7 exists because the failure is not hypothetical: a
 * production deploy was driven by pasting a Portainer password into a session,
 * the session is a transcript, and the password then had to be rotated. The
 * same thing had already happened once before with the same credential.
 *
 * A rule in a document does not stop it happening again. What stops it is
 * having no step that asks: if the only path to Portainer reads a variable and
 * exits when it is missing, there is nothing to type a password into.
 *
 * Two halves, and the second is the one worth having:
 *
 * **Nothing committed contains a password path.** Scanned rather than trusted.
 *
 * **The helper refuses rather than prompts**, proved by running it with the
 * variable unset and a short timeout. A script that prompted would block on a
 * closed stdin or wait for input, and either shows up here as a timeout rather
 * than as a passing test.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Where a credential could plausibly be used. Not the whole repository. */
const SCANNED = [
  "scripts",
  "apps/api/src/scripts",
  "infra",
  ".github/workflows",
];

function filesUnder(dir: string): string[] {
  const full = path.join(ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(full);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const child = path.join(full, entry);
    if (statSync(child).isDirectory()) found.push(...filesUnder(path.join(dir, entry)));
    else if (/\.(m?js|ts|sh|ya?ml|Dockerfile)$/.test(entry) || entry.endsWith("Dockerfile")) {
      found.push(path.join(dir, entry));
    }
  }
  return found;
}

const files = SCANNED.flatMap(filesUnder);

/**
 * Ways a script asks a human for a secret, or carries one itself.
 *
 * Each is a shape rather than a word, so a rename does not slip past. The
 * Portainer entries are specific: `/api/auth` is the username-and-password
 * exchange, and the only reason to call it is to have a password to send.
 */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /PORTAINER_PASSWORD/, why: "a password variable; the token is PORTAINER_TOKEN" },
  { pattern: /\/api\/auth\b/, why: "Portainer's password exchange; use an access token with X-API-Key" },
  { pattern: /read\s+-s\b/, why: "an interactive secret prompt in a shell script" },
  { pattern: /Get-Credential/, why: "an interactive credential prompt" },
  { pattern: /\bprompt\s*\(\s*["'][^"']*(pass|secret|token)/i, why: "an interactive secret prompt" },
  { pattern: /"Password"\s*:/, why: "a password sent in a request body" },
];

describe("nothing committed asks for or carries a credential", () => {
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(path.join("scripts", "portainer.mjs"));
  });

  it("contains no password path", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        // This file names the patterns it forbids, which is not a use of them.
        if (file.endsWith("secrets-hygiene.test.ts")) continue;
        if (pattern.test(source)) offenders.push(`${file}: ${why}`);
      }
    }

    expect(offenders, "a committed file carries or asks for a credential").toEqual([]);
  });
});

describe("the Portainer helper", () => {
  const script = path.join(ROOT, "scripts/portainer.mjs");

  /**
   * The whole point, and it is asserted by running the thing.
   *
   * A five second timeout: a script that prompted would sit waiting, and the
   * failure would be a timeout rather than a wrong exit code. Either way it is
   * red, which is what matters.
   */
  it("refuses without the variable rather than prompting for one", () => {
    const env = { ...process.env };
    delete env.PORTAINER_TOKEN;

    const run = spawnSync(process.execPath, [script, "check"], {
      env,
      encoding: "utf8",
      timeout: 5000,
      input: "",
    });

    expect(run.signal, "the helper did not exit; it is waiting for input").toBeNull();
    expect(run.status, "a missing credential should exit 2, not 0 or 1").toBe(2);
    expect(run.stderr).toContain("PORTAINER_TOKEN");
    // It says where to get one rather than only that it is missing.
    expect(run.stderr).toContain("INFRA.md");
  });

  /** An empty variable is missing, not a credential. */
  it("treats an empty token as missing", () => {
    const run = spawnSync(process.execPath, [script, "check"], {
      env: { ...process.env, PORTAINER_TOKEN: "   " },
      encoding: "utf8",
      timeout: 5000,
      input: "",
    });

    expect(run.status).toBe(2);
  });

  it("authenticates with the token header and never the password exchange", () => {
    const source = readFileSync(script, "utf8");

    expect(source).toContain("X-API-Key");
    expect(source).toContain("PORTAINER_TOKEN");
    expect(source).not.toContain("/api/auth");
  });
});
