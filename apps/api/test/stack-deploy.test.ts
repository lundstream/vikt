import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The merge and its guard, imported rather than driven (D174).
 *
 * Every other test here runs the script as a subprocess, which is right for
 * behaviour that involves Portainer. These two are pure functions, and the case
 * worth testing for `assertNothingDropped` is one the CLI cannot produce: it
 * exists to catch a future bug in the merge, so the test has to hand it a list
 * that has already lost something. `scripts/stack.d.mts` declares just those.
 */
import { assertNothingDropped, nextVariables, type StackVariable } from "../../../scripts/stack.mjs";

type Variable = StackVariable;

/**
 * `scripts/stack.mjs` deploys a version and prints nothing it should not (D164).
 *
 * Portainer returns every stack variable's value in every stack response,
 * `SECRET_KEY` and the database password included, and the update has to send
 * them all back. So the script holds secrets in memory by necessity, and this
 * runs it against a local Portainer and registry that return dummy values for
 * them, and fails if any of those or the token reaches stdout or stderr.
 *
 * The rest is the deploy itself: the update carries every variable unchanged
 * but the two the script owns, asks Portainer to pull, keeps the stack file,
 * and is never sent when a check fails or `--yes` is absent.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPT = path.join(ROOT, "scripts/stack.mjs");
const DUMMY_KEY = `ptr_dummy_${randomBytes(16).toString("hex")}`;
const SENSITIVE = {
  SECRET_KEY: `sk_${randomBytes(16).toString("hex")}`,
  SESSION_SECRET: `ss_${randomBytes(16).toString("hex")}`,
  POSTGRES_PASSWORD: `pg_${randomBytes(16).toString("hex")}`,
  VAPID_PRIVATE_KEY: `vp_${randomBytes(16).toString("hex")}`,
};

const COMPOSE = execFileSync("git", ["show", "HEAD:infra/docker-compose.portainer.yml"], {
  cwd: ROOT,
  encoding: "utf8",
});

/** Every variable the compose refuses to start without, so the fake stack sets them all. */
const REQUIRED = [...COMPOSE.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1] as string);

type Container = { Id: string; service: string; image: string };

let server: Server;
let base = "";

const state = {
  vars: [] as Variable[],
  file: "",
  puts: [] as { url: string; body: Record<string, unknown> }[],
  containers: [] as Container[],
  registryTags: new Set<string>(),
  receivedKeys: [] as string[],
};

function reset(): void {
  state.vars = [
    ...Object.entries(SENSITIVE).map(([name, value]) => ({ name, value })),
    ...REQUIRED.filter((name) => !(name in SENSITIVE) && name !== "IMAGE_TAG").map((name) => ({
      name,
      value: `value-of-${name.toLowerCase()}`,
    })),
    { name: "IMAGE_TAG", value: "1.1.0" },
    { name: "IMAGE_REPO", value: "local/" },
  ];
  state.file = COMPOSE;
  state.puts = [];
  state.containers = [
    { Id: "api1", service: "api", image: "local/vikt-api:1.1.0" },
    { Id: "web1", service: "nginx", image: "local/vikt-web:1.1.0" },
  ];
  state.registryTags = new Set(["1.1.1"]);
  state.receivedKeys = [];
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });
}

function logFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers["x-api-key"]) state.receivedKeys.push(String(req.headers["x-api-key"]));

    // --- the registry, anonymous
    if (url.pathname === "/token") return json(200, { token: "anonymous-pull" });
    const manifest = url.pathname.match(/^\/v2\/lundstream\/(vikt-api|vikt-web)\/manifests\/(.+)$/);
    if (manifest) {
      res.writeHead(state.registryTags.has(manifest[2] as string) ? 200 : 404);
      return res.end();
    }

    // --- Portainer, which echoes every secret back, as the real one does
    if (url.pathname === "/api/stacks") return json(200, [{ Id: 72, Name: "vikt", EndpointId: 2 }]);
    if (url.pathname === "/api/stacks/72" && req.method === "GET") {
      return json(200, { Id: 72, Name: "vikt", EndpointId: 2, Env: state.vars });
    }
    if (url.pathname === "/api/stacks/72/file") return json(200, { StackFileContent: state.file });
    if (url.pathname === "/api/stacks/72" && req.method === "PUT") {
      const parsed = JSON.parse(await body(req)) as Record<string, unknown>;
      state.puts.push({ url: req.url ?? "", body: parsed });
      const tag = (parsed.env as Variable[]).find((v) => v.name === "IMAGE_TAG")?.value;
      const repo = (parsed.env as Variable[]).find((v) => v.name === "IMAGE_REPO")?.value;
      state.containers = [
        { Id: "api2", service: "api", image: `${repo}vikt-api:${tag}` },
        { Id: "web2", service: "nginx", image: `${repo}vikt-web:${tag}` },
      ];
      return json(200, { Id: 72, Env: parsed.env });
    }
    if (url.pathname === "/api/endpoints/2/docker/containers/json") {
      return json(
        200,
        state.containers.map((c) => ({
          Id: c.Id,
          Names: [`/vikt-${c.service}-1`],
          Image: c.image,
          State: "running",
          Labels: { "com.docker.compose.service": c.service },
        })),
      );
    }
    const detail = url.pathname.match(/^\/api\/endpoints\/2\/docker\/containers\/(\w+)\/json$/);
    if (detail) {
      const c = state.containers.find((x) => x.Id === detail[1]);
      return json(200, {
        Config: { Image: c?.image },
        State: { Status: "running", Health: c?.service === "api" ? { Status: "healthy" } : undefined },
      });
    }
    if (/\/containers\/\w+\/logs$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(
        logFrame(
          "Running migrations...\nMigrations: 0 applied, 30 recorded in total\nsomething unrelated\n" +
            '{"level":30,"msg":"api build","version":"1.1.1","commit":"12a9daa"}\napi up\n',
        ),
      );
    }
    if (url.pathname === "/api/endpoints/2/docker/images/json") {
      return json(200, [{ RepoTags: ["local/vikt-api:1.1.0", "local/vikt-web:1.1.0"] }]);
    }
    json(404, { message: `no route ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(reset);

type Run = { code: number | null; stdout: string; stderr: string };

/** Asynchronous, because the fake server lives in this process (see secrets-echo.test.ts). */
function run(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORTAINER_TOKEN: DUMMY_KEY,
        PORTAINER_URL: base,
        REGISTRY_URL: base,
        STACK_POLL_MS: "20",
        STACK_WAIT_MS: "2000",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("stack.mjs did not exit within 15 s"));
    }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Every secret that turned up in the output, by name, so a failure says which. */
function leaked(result: Run): string[] {
  const output = result.stdout + result.stderr;
  const found = Object.entries(SENSITIVE)
    .filter(([, value]) => output.includes(value))
    .map(([name]) => name);
  if (output.includes(DUMMY_KEY)) found.push("PORTAINER_TOKEN");
  return found;
}

describe("stack.mjs plan", () => {
  it("says what would change, sends nothing, and prints no secret", async () => {
    const result = await run(["plan", "1.1.1", "--ref", "HEAD"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(state.receivedKeys).toContain(DUMMY_KEY);
    expect(result.stdout).toMatch(/IMAGE_TAG\s+1\.1\.0 -> 1\.1\.1/);
    expect(result.stdout).toMatch(/IMAGE_REPO\s+local\/ -> ghcr\.io\/lundstream\//);
    expect(result.stdout).toContain("ghcr.io/lundstream/vikt-api:1.1.1 anonymously pullable");
    expect(result.stdout).toContain("new in the release and not set: none");
    expect(result.stdout).toContain("nothing blocks this deploy");
    expect(state.puts).toHaveLength(0);
    expect(leaked(result)).toEqual([]);
  });

  it("blocks on a tag the registry does not have", async () => {
    const result = await run(["plan", "9.9.9", "--ref", "HEAD"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/blocked: ghcr\.io\/lundstream\/vikt-api:9\.9\.9/);
    expect(leaked(result)).toEqual([]);
  });
});

describe("stack.mjs deploy", () => {
  it("changes nothing without --yes", async () => {
    const result = await run(["deploy", "1.1.1", "--ref", "HEAD"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Run again with --yes");
    expect(state.puts).toHaveLength(0);
  });

  it("sends every variable back unchanged but the two it owns, pulls, and waits", async () => {
    const before = structuredClone(state.vars);
    const result = await run(["deploy", "1.1.1", "--ref", "HEAD", "--yes"]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(state.puts).toHaveLength(1);

    const put = state.puts[0] as { url: string; body: Record<string, unknown> };
    expect(put.url).toBe("/api/stacks/72?endpointId=2");
    expect(put.body.pullImage).toBe(true);
    expect(put.body.prune).toBe(false);
    expect(put.body.stackFileContent).toBe(COMPOSE);

    const sent = new Map((put.body.env as Variable[]).map((v) => [v.name, v.value]));
    for (const { name, value } of before) {
      if (name === "IMAGE_TAG") expect(sent.get(name)).toBe("1.1.1");
      else if (name === "IMAGE_REPO") expect(sent.get(name)).toBe("ghcr.io/lundstream/");
      else expect(sent.get(name), name).toBe(value);
    }
    expect(sent.size).toBe(before.length);

    expect(result.stdout).toContain("Migrations: 0 applied, 30 recorded in total");
    /**
     * The version, which is the line INFRA.md step 6 reads first (D169). It is
     * baked into the image, so it is the only thing in the log that can say
     * whether the pull actually replaced anything, and the excerpt used to drop
     * it while keeping everything around it.
     */
    expect(result.stdout).toContain('"msg":"api build"');
    expect(result.stdout).toContain('"version":"1.1.1"');
    expect(result.stdout).not.toContain("something unrelated");
    expect(result.stdout).toContain("deployed 1.1.1");
    expect(leaked(result), "a secret the server returned was printed").toEqual([]);
  });

  it("refuses a stack file that does not read IMAGE_TAG, and sends nothing", async () => {
    state.file = COMPOSE.replace(/\$\{IMAGE_TAG:\?[^}]*\}/g, "d11c2fe");
    const result = await run(["deploy", "1.1.1", "--ref", "HEAD", "--yes", "--keep-file"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/does not read IMAGE_TAG/);
    expect(state.puts).toHaveLength(0);
  });

  it("refuses a stack file that differs from the release's until told which to use", async () => {
    state.file = `${COMPOSE}\n# edited in Portainer\n`;
    const refused = await run(["deploy", "1.1.1", "--ref", "HEAD", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(/--release-file or --keep-file/);
    expect(state.puts).toHaveLength(0);

    const replaced = await run(["deploy", "1.1.1", "--ref", "HEAD", "--yes", "--release-file"]);
    expect(replaced.code).toBe(0);
    expect((state.puts[0] as { body: Record<string, unknown> }).body.stackFileContent).toBe(COMPOSE);
  });

  it("checks the host rather than the registry for a local build", async () => {
    const result = await run(["plan", "1.1.0", "--ref", "HEAD", "--repo", "local/"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("local/vikt-api:1.1.0 present on the host");
    expect(leaked(result)).toEqual([]);
  });
});

/**
 * Setting stack variables from the script (D174).
 *
 * The runbook used to say "set the variable in the panel", which means a second
 * update and therefore a second restart, the first of which runs the new image
 * without the variable it was given. These all check the same property from
 * different sides: **one update carries the file, the tag and the variables**,
 * and nothing else about the stack changes.
 */
describe("stack.mjs variables", () => {
  const HOST_DIR = "/var/backups/vikt/app";

  it("sets a variable and the compose file in the same update", async () => {
    const before = structuredClone(state.vars);
    const result = await run([
      "deploy",
      "1.1.1",
      "--ref",
      "HEAD",
      "--yes",
      "--release-file",
      "--set",
      `BACKUP_HOST_DIR=${HOST_DIR}`,
    ]);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    // One update. Not one for the file and another for the variable.
    expect(state.puts).toHaveLength(1);
    const put = state.puts[0] as { body: Record<string, unknown> };
    expect(put.body.stackFileContent).toBe(COMPOSE);

    const sent = new Map((put.body.env as Variable[]).map((v) => [v.name, v.value]));
    expect(sent.get("BACKUP_HOST_DIR")).toBe(HOST_DIR);
    expect(sent.get("IMAGE_TAG")).toBe("1.1.1");

    // And every variable the stack already had is still there, untouched
    // except the one this run was asked to change.
    for (const { name, value } of before) {
      if (["IMAGE_TAG", "IMAGE_REPO", "BACKUP_HOST_DIR"].includes(name)) continue;
      expect(sent.get(name), `${name} was dropped`).toBe(value);
    }
    expect(leaked(result)).toEqual([]);
  });

  it("refuses a secret given on the command line, and says what to use", async () => {
    const result = await run(["plan", "1.1.1", "--ref", "HEAD", "--set", "SECRET_KEY=hunter2"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/looks like a secret/);
    expect(result.stderr).toMatch(/--set-from-env SECRET_KEY/);
    // The value it refused is not echoed back in the refusal.
    expect(result.stdout + result.stderr).not.toContain("hunter2");
    expect(state.puts).toHaveLength(0);
  });

  it("takes a secret from this shell instead, and never prints it", async () => {
    const secret = `sk_${"a1b2c3d4".repeat(2)}`;
    const result = await run(
      ["deploy", "1.1.1", "--ref", "HEAD", "--yes", "--set-from-env", "NEW_SECRET_KEY"],
      { NEW_SECRET_KEY: secret },
    );

    expect(result.code).toBe(0);
    const sent = new Map(
      ((state.puts[0] as { body: Record<string, unknown> }).body.env as Variable[]).map((v) => [
        v.name,
        v.value,
      ]),
    );
    expect(sent.get("NEW_SECRET_KEY")).toBe(secret);
    expect(result.stdout + result.stderr).not.toContain(secret);
    // The name is fine to print, and is how the operator knows it happened.
    expect(result.stdout).toMatch(/NEW_SECRET_KEY \(new\)/);
  });

  it("says nothing about a value in the plan, only the name and whether it moves", async () => {
    const result = await run([
      "plan",
      "1.1.1",
      "--ref",
      "HEAD",
      "--set",
      `BACKUP_HOST_DIR=${HOST_DIR}`,
    ]);

    // The compose already requires it, so the stack has it and this is a change
    // rather than an addition. Either way the value is not printed.
    expect(result.stdout).toMatch(/setting: BACKUP_HOST_DIR \(changed\)/);
    expect(result.stdout + result.stderr).not.toContain(HOST_DIR);
    expect(state.puts).toHaveLength(0);
  });

  it("refuses to send a list that has lost a variable the stack had", () => {
    const current = [
      { name: "SECRET_KEY", value: "x" },
      { name: "IMAGE_TAG", value: "1.1.0" },
    ];

    // The guard, not the merge: this is what stands between a future bug in
    // `nextVariables` and Portainer deleting the environment it was sent.
    expect(() => assertNothingDropped(current, [{ name: "IMAGE_TAG", value: "1.1.1" }], [])).toThrow(
      /would drop SECRET_KEY/,
    );

    // Named to --unset, the same removal is allowed.
    expect(() =>
      assertNothingDropped(current, [{ name: "IMAGE_TAG", value: "1.1.1" }], ["SECRET_KEY"]),
    ).not.toThrow();
  });

  it("removes a variable only when --unset names it", async () => {
    state.vars.push({ name: "OLD_THING", value: "leftover" });

    const result = await run(["deploy", "1.1.1", "--ref", "HEAD", "--yes", "--unset", "OLD_THING"]);

    expect(result.code).toBe(0);
    const sent = (state.puts[0] as { body: Record<string, unknown> }).body.env as Variable[];
    expect(sent.some((v) => v.name === "OLD_THING")).toBe(false);
    expect(result.stdout).toMatch(/unsetting: OLD_THING/);
  });

  it("merges without touching anything it was not asked about", () => {
    const current = [
      { name: "SECRET_KEY", value: "keep" },
      { name: "IMAGE_TAG", value: "1.1.0" },
      { name: "IMAGE_REPO", value: "local/" },
    ];

    const next = nextVariables(current, {
      repo: "ghcr.io/lundstream/",
      version: "1.2.0",
      set: { BACKUP_HOST_DIR: "/var/backups/vikt/app" },
      unset: [],
    });

    expect(next).toEqual([
      { name: "SECRET_KEY", value: "keep" },
      { name: "IMAGE_TAG", value: "1.2.0" },
      { name: "IMAGE_REPO", value: "ghcr.io/lundstream/" },
      { name: "BACKUP_HOST_DIR", value: "/var/backups/vikt/app" },
    ]);
  });
});
