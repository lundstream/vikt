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
    else if (/\.(m?js|cjs|mts|ts|sh|ps1|ya?ml|Dockerfile)$/.test(entry) || entry.endsWith("Dockerfile")) {
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
/**
 * `only`, where present, limits a pattern to files it can mean something in.
 *
 * Added after the env-command pattern's first run flagged three API scripts for
 * `createLlmClient(env)`: in TypeScript `env` is an ordinary identifier, and a
 * pattern that reads shell syntax will keep finding shell-looking shapes in a
 * language that is not shell. Spawning `env` from JavaScript is still caught,
 * by the quoted-string pattern below it, which has no scope.
 */
const FORBIDDEN: { pattern: RegExp; why: string; only?: RegExp }[] = [
  { pattern: /PORTAINER_PASSWORD/, why: "a password variable; the token is PORTAINER_TOKEN" },
  { pattern: /\/api\/auth\b/, why: "Portainer's password exchange; use an access token with X-API-Key" },
  { pattern: /read\s+-s\b/, why: "an interactive secret prompt in a shell script" },
  { pattern: /Get-Credential/, why: "an interactive credential prompt" },
  { pattern: /\bprompt\s*\(\s*["'][^"']*(pass|secret|token)/i, why: "an interactive secret prompt" },
  { pattern: /"Password"\s*:/, why: "a password sent in a request body" },

  /**
   * Listing the environment (D158 addendum).
   *
   * A listing of the environment is a listing of every secret in it, and in a
   * recorded session it is a transcript of all of them at once. There is never
   * a reason for a committed script to do it: a script that needs a variable
   * reads that variable by name.
   *
   * `env` is only matched as a **command** — at the start of a line or after a
   * shell separator, and followed by a pipe, a redirect or the end — because
   * `const env = loadEnv()` and a workflow's `env:` key are ordinary and
   * everywhere. `env FOO=bar node x.mjs`, which sets a variable for one command,
   * is not a listing and does not match.
   */
  { pattern: /\bprintenv\b/, why: "printenv lists or prints the environment" },
  {
    // `$(` and a backtick, not a bare `(`: `$(env)` is command substitution,
    // `createLlmClient(env)` is a function call.
    pattern: /(^|[;&|]|\$\(|`|(?:run|script):)\s*env\s*($|[|>)`;&])/m,
    why: "env run as a command lists the environment",
    only: /\.(sh|ps1|ya?ml)$|Dockerfile$/,
  },
  { pattern: /["'`]env["'`]/, why: "spawning env lists the environment" },
  {
    pattern: /\b(Get-ChildItem|gci|dir|ls|Get-Item)\s+env:/i,
    why: "listing PowerShell's env: drive lists the environment",
  },

  /** Writing a secret to a file, where it outlives the session and gets committed. */
  {
    pattern: /\b(Set-Content|Add-Content|Out-File|tee)\b[^\n]*(TOKEN|SECRET|PASSWORD|API_?KEY)/i,
    why: "a secret written to a file",
  },
  {
    pattern: /\$\{?(env:)?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_?KEY)[A-Za-z_]*\}?[^\n]*>{1,2}\s*[^\s&|]/i,
    why: "a secret redirected into a file",
  },
  {
    pattern: /(writeFile(Sync)?|appendFile(Sync)?|createWriteStream)\s*\([^\n]*process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD|API_?KEY)/,
    why: "a secret from the environment written to a file",
  },

  /**
   * Printing a secret's value.
   *
   * The value, not the name: "SECRET_KEY is not set" names a variable and is
   * exactly what a refusal should say. What is refused is interpolating one — a
   * `$VAR` in an echo, a `process.env.X_TOKEN` in a log call, a `${token}` in a
   * template that is being written out.
   */
  {
    pattern: /\b(echo|printf|Write-Host|Write-Output)\b[^\n]*\$(\{|env:)?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_?KEY)/i,
    why: "a secret's value echoed",
  },
  {
    pattern:
      /(console\.(log|error|warn|info|debug)|process\.std(out|err)\.write|\b(log|logger)\.(info|warn|error|debug|trace))\s*\([^\n]*(process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD|API_?KEY)|\$\{[^}]*\b(token|secret|password|apiKey)\b[^}]*\})/i,
    why: "a secret's value logged",
  },
];

/**
 * Lines each pattern exists to catch, and lines no pattern may touch.
 *
 * Tested against the table directly rather than by committing an offender, so
 * the guard is shown to bite without the repository ever containing the thing
 * it forbids. The innocent half matters as much: a guard that fires on
 * `const env = loadEnv()` would be switched off within a day.
 */
export const OFFENDERS = [
  "Get-ChildItem env:",
  "gci env: | Sort-Object Name",
  "env | grep PORTAINER",
  "run: env",
  "printenv PORTAINER_TOKEN",
  'execSync("env")',
  "Set-Content token.txt $env:PORTAINER_TOKEN",
  "echo $PORTAINER_TOKEN > ~/.portainer",
  'echo "using $PORTAINER_TOKEN"',
  'Write-Host "token is $env:PORTAINER_TOKEN"',
  "console.log(process.env.PORTAINER_TOKEN)",
  "process.stderr.write(`key=${token}`)",
  'writeFileSync("t.txt", process.env.PORTAINER_TOKEN)',
];

export const INNOCENTS = [
  "const env = loadEnv();",
  "    env:",
  "const token = process.env.PORTAINER_TOKEN;",
  'process.stderr.write("SECRET_KEY is not set, so this file cannot be read.\\n");',
  "console.log(`token works: ${me.Username} (role ${me.Role})`);",
  'import { loadEnv } from "../env.js";',
  '"X-API-Key": requireToken(),',
  // The false positive that narrowed the env-command pattern (D158 addendum).
  "const llm = createLlmClient(env);",
  "env FOO=bar node script.mjs",
  'echo "::error::token endpoint returned 200 with no token for $repo"',
  "ENV NODE_ENV=production",
];

describe("the patterns", () => {
  it("catch every line they exist to catch", () => {
    const missed = OFFENDERS.filter(
      (line) => !FORBIDDEN.some(({ pattern }) => pattern.test(line)),
    );

    expect(missed, "a forbidden line passes the guard").toEqual([]);
  });

  it("leave ordinary code alone", () => {
    const flagged = INNOCENTS.flatMap((line) =>
      FORBIDDEN.filter(({ pattern }) => pattern.test(line)).map(({ why }) => `${line} -> ${why}`),
    );

    expect(flagged, "an ordinary line trips the guard").toEqual([]);
  });
});

describe("nothing committed asks for or carries a credential", () => {
  it("has files to scan", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(path.join("scripts", "portainer.mjs"));
  });

  it("contains no password path", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const { pattern, why, only } of FORBIDDEN) {
        if (only && !only.test(file)) continue;
        // This file names the patterns it forbids, which is not a use of them.
        if (file.endsWith("secrets-hygiene.test.ts")) continue;
        if (pattern.test(source)) offenders.push(`${file}: ${why}`);
      }
    }

    // Joined rather than compared as an array: a failure has to name each file
    // and the reason, and an array diff is truncated to a count.
    expect(offenders.join("\n"), "a committed file carries or asks for a credential").toBe("");
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
