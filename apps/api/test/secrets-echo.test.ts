import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * A token handed to `scripts/portainer.mjs` never comes back out (§7, D158).
 *
 * The static scan in `secrets-hygiene.test.ts` catches a script that *means* to
 * print a secret. This catches the one that does it by accident, which is the
 * more likely kind: the helper prints error bodies and response bodies, and a
 * body is whatever the server chose to send. A proxy that echoes request
 * headers into an error page, or an endpoint that reflects the caller, puts
 * the token straight into stderr, and from there into whatever is recording the
 * session.
 *
 * So the helper is run against a local server that is deliberately hostile: it
 * echoes the `X-API-Key` it received into every response, successful or not.
 * The token is a dummy generated per run, so a leak is unmistakable and a real
 * credential is never anywhere near this test.
 *
 * Three places are checked after every run: stdout, stderr, and every file
 * under the working directory, the temp directory and the home directory the
 * helper was given. The helper writes no files today; the last check is there
 * so that a future log file cannot become the leak.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(ROOT, "scripts/portainer.mjs");
const DUMMY = `ptr_dummy_${randomBytes(16).toString("hex")}`;

let server: Server;
let base = "";
const received: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers["x-api-key"] ?? "");
    received.push(key);

    if (req.url === "/api/users/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Username: `reflected ${key}`, Role: 2 }));
      return;
    }
    if (req.url === "/echo-ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ youSent: key }));
      return;
    }
    if (req.url === "/echo-fail") {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`refused, the key was ${key}`);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`no such route, but thanks for ${key}`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Run = { code: number | null; stdout: string; stderr: string; dirs: string[] };

/**
 * One run of the helper, asynchronously.
 *
 * `spawn` rather than `spawnSync`: the server above lives in this process, and
 * a synchronous spawn blocks the event loop, so the server could never answer
 * the request the child is waiting on.
 */
function run(args: string[], url: string): Promise<Run> {
  const cwd = mkdtempSync(path.join(tmpdir(), "vikt-echo-cwd-"));
  const tmp = mkdtempSync(path.join(tmpdir(), "vikt-echo-tmp-"));
  const home = mkdtempSync(path.join(tmpdir(), "vikt-echo-home-"));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd,
      env: {
        ...process.env,
        // The dummy replaces whatever is in this shell, so a real token is
        // never passed to the child at all.
        PORTAINER_TOKEN: DUMMY,
        PORTAINER_URL: url,
        TMP: tmp,
        TEMP: tmp,
        TMPDIR: tmp,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("portainer.mjs did not exit within 10 s"));
    }, 10_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, dirs: [cwd, tmp, home] });
    });
  });
}

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

/** Everywhere the dummy turned up, as a list, so a failure names the place. */
function leaks(result: Run): string[] {
  const where: string[] = [];
  if (result.stdout.includes(DUMMY)) where.push("stdout");
  if (result.stderr.includes(DUMMY)) where.push("stderr");
  for (const dir of result.dirs) {
    for (const file of filesUnder(dir)) {
      if (readFileSync(file, "utf8").includes(DUMMY)) where.push(file);
    }
    rmSync(dir, { recursive: true, force: true });
  }
  return where;
}

describe("a token given to the Portainer helper", () => {
  /**
   * First, that the token really is sent. Every check below would pass
   * trivially if the helper failed before making a request.
   */
  it("is sent to the server, so the checks below are not vacuous", async () => {
    received.length = 0;
    const result = await run(["check"], base);
    leaks(result);

    expect(received).toContain(DUMMY);
  });

  it("does not come back out of a success the server reflected it into", async () => {
    const result = await run(["check"], base);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("token works");
    expect(leaks(result), "the reflected token was printed").toEqual([]);
  });

  it("does not come back out of a response body the helper prints", async () => {
    const result = await run(["get", "/echo-ok"], base);

    expect(result.code).toBe(0);
    // Redacted, rather than silently dropped: the body is still printed.
    expect(result.stdout).toContain("<redacted>");
    expect(leaks(result), "the echoed token was printed").toEqual([]);
  });

  it("does not come back out of an error body the helper prints", async () => {
    const result = await run(["get", "/echo-fail"], base);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 401");
    expect(leaks(result), "the token in the error page was printed").toEqual([]);
  });

  it("does not come back out when the server cannot be reached at all", async () => {
    // Port 9 is discard: nothing listens there on a workstation or a runner.
    const result = await run(["check"], "http://127.0.0.1:9");

    expect(result.code).not.toBe(0);
    expect(leaks(result)).toEqual([]);
  });
});
