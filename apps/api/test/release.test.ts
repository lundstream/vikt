import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildSteps,
  readHandover,
  readNewsPost,
  release,
  stackArgs,
} from "../../../scripts/release.mjs";

/**
 * `scripts/release.mjs` runs the runbook and stops at the first bad answer (D182).
 *
 * ## What is faked, and what is not
 *
 * The **runner** is faked: every step reaches the world through `local()` and
 * `remote()`, so a test can answer as git, gh, ssh and curl would and then read
 * back exactly what the step concluded. That is what makes "every step" and
 * "stops at the first failure" testable at all, because the real versions of
 * those need a host, a GitHub and a production stack.
 *
 * The **stack** is not faked at the same level: the plan step runs the real
 * `scripts/stack.mjs` against a local Portainer double, so what is exercised is
 * the two scripts talking to each other and to an API that answers the way
 * Portainer does. A release command whose deploy step is a string comparison
 * would pass every test here and fail on the day.
 *
 * ## Why the failure cases are one per step
 *
 * Stopping at the first failure is the property this whole command exists for:
 * a half-finished deploy is the state this project can least afford. A single
 * test that fails the first step proves the loop breaks; it does not prove that
 * the *tenth* step's failure stops the eleventh. So every step is failed in
 * turn, and each case asserts both the stop and that nothing after it ran.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const STATE = readFileSync(path.join(ROOT, "STATE.md"), "utf8");

/* ----------------------------------------------------------- the fake world -- */

type Call = { kind: "local" | "remote"; command: string };

/** What a healthy world says, keyed by the start of the command. */
function healthyWorld(): Record<string, { code: number; out: string }> {
  const head = "a".repeat(40);
  return {
    "gh auth status": { code: 0, out: "Logged in to github.com" },
    "git status --porcelain": { code: 0, out: "" },
    "git rev-parse --abbrev-ref HEAD": { code: 0, out: "dev" },
    "git fetch origin dev": { code: 0, out: "" },
    "git fetch origin main": { code: 0, out: "" },
    "git rev-list --count origin/dev..HEAD": { code: 0, out: "0" },
    "git rev-parse --short HEAD": { code: 0, out: "abc1234" },
    "git rev-parse HEAD": { code: 0, out: head },
    "gh run list --branch dev": {
      code: 0,
      out: JSON.stringify([
        { headSha: head, status: "completed", conclusion: "success", displayTitle: "Record the pass" },
      ]),
    },
    "ssh /srv/vikt/infra/backup.sh": {
      code: 0,
      out: [
        "[2026-09-17T20:00:00Z] backing up to /var/backups/vikt",
        "  database: 3,4M  /var/backups/vikt/vikt-20260917T200000Z.dump",
        "  uploads:  /srv/vikt/infra/data/uploads does not exist yet, skipped",
        "[2026-09-17T20:00:04Z] done. 3 dumps kept, retention 30d",
      ].join("\n"),
    },
    "ssh /srv/vikt/infra/restore-check.sh": {
      code: 0,
      out: [
        "--- what came back ---",
        "users 4",
        "weight_log 912",
        "--- against the live database ---",
        "users 4",
        "weight_log 912",
      ].join("\n"),
    },
    /* A sha goes on either side of the range, so these are patterns, not text. */
    "git rev-list --count origin/main\\.\\.": { code: 0, out: "6" },
    "git rev-list --count [0-9a-f]+\\.\\.origin/main": { code: 0, out: "0" },
    "git push origin": { code: 0, out: "" },
    "gh release view": { code: 1, out: "release not found" },
    "gh release create": { code: 0, out: "https://github.com/lundstream/vikt/releases/tag/v1.2.0" },
    /*
      Two runs for the tag, as release.yml really produces (D169), plus an older
      failed run for something else. The step has to take the `release` one.
    */
    "gh run list --workflow release.yml": {
      code: 0,
      out: JSON.stringify([
        { databaseId: 42, status: "completed", conclusion: "success", headBranch: "v1.2.0", event: "release" },
        { databaseId: 41, status: "completed", conclusion: "cancelled", headBranch: "v1.2.0", event: "push" },
        { databaseId: 9, status: "completed", conclusion: "failure", headBranch: "main", event: "push" },
      ]),
    },
    "node .*stack.mjs plan": { code: 0, out: "…\nnothing blocks this deploy" },
    "node .*stack.mjs deploy": { code: 0, out: "set IMAGE_TAG=1.2.0\npulled\nredeployed\nup" },
    "ssh docker logs": {
      code: 0,
      out: [
        "vikt-api 1.2.0 (build 9f2c1a3)",
        "Migrations: 2 applied, 32 recorded in total",
        "  0030_food_search_fold applied",
        "  0031_restore_checks applied",
        "VAPID public key unchanged since last boot",
        "vision self-test: SEES (qwen2.5vl:7b)",
      ].join("\n"),
    },
    "curl .*api/health": { code: 0, out: '{"ok":true}\n200' },
    "curl .*4173|curl .*/$": { code: 0, out: "200" },
    "ssh cat >": { code: 0, out: "" },
    "ssh docker cp": { code: 0, out: 'published "Version 1.2.0" as 8f1c, 1240 characters, not mailed' },
  };
}

class FakeRunner {
  dryRun = false;
  calls: Call[] = [];
  world: Record<string, { code: number; out: string }>;
  /** Command fragment to fail, and what it says when it does. */
  breakAt: { match: string; out: string } | null = null;

  constructor(world = healthyWorld()) {
    this.world = world;
  }

  private answer(kind: "local" | "remote", command: string) {
    this.calls.push({ kind, command });

    if (this.breakAt && new RegExp(this.breakAt.match).test(command)) {
      return { code: 1, out: this.breakAt.out };
    }
    for (const [pattern, result] of Object.entries(this.world)) {
      if (new RegExp(pattern).test(command)) return result;
    }
    return { code: 0, out: "" };
  }

  local(file: string, args: string[]) {
    return this.answer("local", `${file} ${args.join(" ")}`);
  }

  remote(host: string, command: string) {
    return this.answer("remote", `ssh ${command}`);
  }
}

/** Collects what the command printed, so the evidence can be read back. */
function sink() {
  const lines: string[] = [];
  return { write: (text: string) => lines.push(text), text: () => lines.join("") };
}

const ENV = { VIKT_HOST: "deploy@192.168.1.30", PORTAINER_TOKEN: "ptr_dummy" };

function withEnv<T>(extra: Record<string, string | undefined>, run: () => T): T {
  const before = { ...process.env };
  Object.assign(process.env, ENV);
  /*
    `Object.assign` with an `undefined` value writes the **string**
    "undefined", which is set as far as anything reading it is concerned. A
    test for "this variable is missing" has to actually remove it.
  */
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

/* ------------------------------------------------------------ STATE.md, read -- */

describe("what STATE.md says the release needs", () => {
  it("finds the version's own handover", () => {
    const handover = readHandover(STATE, "1.2.0");
    expect(handover.ok, `STATE.md's handover does not mention 1.2.0`).toBe(true);
  });

  /**
   * The `--set` list is read out of the documented command rather than kept a
   * second time in a config file. D156 is what happens when the thing that runs
   * and the thing that is written down are two copies: a variable was set in a
   * panel that the deployed compose never read.
   */
  it("reads the same --set list the documented command uses", () => {
    const handover = readHandover(STATE, "1.2.0");
    expect(handover.ok).toBe(true);
    if (!handover.ok) return;

    expect(handover.sets.map((entry) => entry.name)).toContain("BACKUP_HOST_DIR");
    const args = stackArgs("1.2.0", handover, "plan");
    expect(args.slice(0, 3)).toEqual(["plan", "1.2.0", "--release-file"]);
    expect(args.join(" ")).toContain("--set BACKUP_HOST_DIR=");
  });

  /** Anything sensitive is named, never valued, on the command line (§7). */
  it("passes sensitive variables by name only", () => {
    const handover = { ok: true as const, sets: [], fromEnv: ["SECRET_KEY"], commit: null };
    const args = stackArgs("1.2.0", handover, "deploy");
    expect(args).toContain("--set-from-env");
    expect(args).toContain("SECRET_KEY");
    expect(args.join(" ")).not.toMatch(/SECRET_KEY=/);
  });

  it("takes the Nyheter post out of STATE.md's own block", () => {
    const post = readNewsPost(STATE, "1.2.0");
    expect(post, "no ## Version 1.2.0 block in STATE.md").not.toBeNull();
    expect(post).toMatch(/^# Version 1\.2\.0\n/);
    expect(post!.length).toBeGreaterThan(200);
  });
});

/* ------------------------------------------------------------- every step -- */

describe("a release where everything answers well", () => {
  it("runs every step and says so", async () => {
    const runner = new FakeRunner();
    const out = sink();
    const result = await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));

    const text = out.text();
    expect(result, text).toMatchObject({ ok: true });
    expect(text).not.toContain("FAIL");
    expect(text).toContain("1.2.0 is live");
  });

  /** Each step's evidence, not just that it passed. */
  it("prints what it found at each step", async () => {
    const runner = new FakeRunner();
    const out = sink();
    await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));
    const text = out.text();

    for (const evidence of [
      "VIKT_HOST set",
      "clean, on dev, pushed",
      "success for abc1234",
      "/var/backups/vikt/vikt-20260917T200000Z.dump",
      "users 4",
      "main fast-forwarded",
      "v1.2.0 created",
      "run 42 (release, v1.2.0) is success",
      "nothing blocks this deploy",
      "Migrations: 2 applied",
      "/api/health 200",
      'published "Version 1.2.0"',
    ]) {
      expect(text, `no evidence for: ${evidence}`).toContain(evidence);
    }
  });

  /** Neither the token nor the host's user reaches the output (§7). */
  it("prints no secret", async () => {
    const runner = new FakeRunner();
    const out = sink();
    await withEnv({ PORTAINER_TOKEN: "ptr_a_real_looking_token" }, () =>
      release({ version: "1.2.0", runner, out, root: ROOT }),
    );
    expect(out.text()).not.toContain("ptr_a_real_looking_token");
  });

  /** The host is reached with a key and no password, ever (§7). */
  it("never offers a password to the host", async () => {
    const runner = new FakeRunner();
    await withEnv({}, () => release({ version: "1.2.0", runner, out: sink(), root: ROOT }));

    const steps = buildSteps({ version: "1.2.0", runner: new FakeRunner(), root: ROOT });
    expect(steps.length).toBeGreaterThan(10);

    /* The real runner's ssh flags, asserted on the source rather than mocked. */
    const source = readFileSync(path.join(ROOT, "scripts/release.mjs"), "utf8");
    expect(source).toContain('"BatchMode=yes"');
    expect(source).toContain('"PasswordAuthentication=no"');
    expect(source).not.toMatch(/sshpass|--password|-o\s*PasswordAuthentication=yes/);
  });
});

describe("a release that stops", () => {
  /**
   * One case per step. The fragment is what that step asks the world, so
   * failing it fails exactly that step and nothing earlier.
   */
  const cases: { step: number; name: string; match: string }[] = [
    { step: 2, name: "the working tree is clean", match: "git status --porcelain" },
    { step: 3, name: "CI is green", match: "gh run list --branch dev" },
    { step: 4, name: "the backup", match: "backup\\.sh" },
    { step: 5, name: "the restore check", match: "restore-check\\.sh" },
    { step: 6, name: "main fast-forwards", match: "git push origin" },
    { step: 7, name: "the tag", match: "gh release create" },
    { step: 8, name: "the workflow", match: "gh run list --workflow" },
    { step: 9, name: "the plan", match: "stack\\.mjs plan" },
    { step: 10, name: "the deploy", match: "stack\\.mjs deploy" },
    { step: 11, name: "the API log", match: "docker logs" },
    { step: 12, name: "the site", match: "api/health" },
    { step: 13, name: "the Nyheter post", match: "docker cp" },
  ];

  for (const { step, name, match } of cases) {
    it(`stops at step ${step} when ${name} fails, and attempts nothing after`, async () => {
      const runner = new FakeRunner();
      runner.breakAt = { match, out: "the world said no" };
      const out = sink();

      const result = await withEnv({}, () =>
        release({ version: "1.2.0", runner, out, root: ROOT }),
      );

      expect(result, out.text()).toMatchObject({ ok: false, stoppedAt: step });
      expect(out.text()).toContain(`stopped at step ${step}/`);

      /* Nothing belonging to a later step was asked. */
      const later = cases.filter((c) => c.step > step);
      for (const after of later) {
        const asked = runner.calls.some((call) => new RegExp(after.match).test(call.command));
        expect(asked, `step ${step} failed but ${after.name} was still attempted`).toBe(false);
      }
    });
  }

  it("stops at step 1 when VIKT_HOST is not set, and names where to set it", async () => {
    const runner = new FakeRunner();
    const out = sink();
    const result = await withEnv({ VIKT_HOST: undefined }, () =>
      release({ version: "1.2.0", runner, out, root: ROOT }),
    );

    expect(result).toMatchObject({ ok: false, stoppedAt: 1 });
    expect(out.text()).toContain("VIKT_HOST is not set");
    expect(out.text()).toContain("what would have to be true");
    expect(runner.calls.some((c) => /backup\.sh/.test(c.command))).toBe(false);
  });

  it("stops when the plan does not end clean", async () => {
    const runner = new FakeRunner({
      ...healthyWorld(),
      "node .*stack.mjs plan": { code: 0, out: "IMAGE_TAG missing\nnothing blocks this deploy" },
    });
    const out = sink();
    const result = await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));

    expect(result).toMatchObject({ ok: false, stoppedAt: 9 });
    expect(out.text()).toContain("reports something missing");
    expect(runner.calls.some((c) => /stack\.mjs deploy/.test(c.command))).toBe(false);
  });

  /**
   * The defect that stopped the first real release of 1.2.0.
   *
   * The tag had been pushed a second earlier and GitHub had not registered its
   * run yet, so "the newest run of release.yml" was a run from two days before
   * that had failed for an unrelated reason. The command stopped, correctly, on
   * an answer about something else entirely.
   *
   * Proof by reintroduction: a world where the only runs are old ones must not
   * produce a verdict about them.
   */
  it("never reports an older run as this tag's", async () => {
    const runner = new FakeRunner({
      ...healthyWorld(),
      "gh run list --workflow release.yml": {
        code: 0,
        out: JSON.stringify([
          { databaseId: 9, status: "completed", conclusion: "failure", headBranch: "main", event: "push" },
          { databaseId: 8, status: "completed", conclusion: "success", headBranch: "v1.1.1", event: "release" },
        ]),
      },
    });
    const out = sink();
    const result = await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));

    expect(result).toMatchObject({ ok: false, stoppedAt: 8 });
    /* It says no run appeared, not that a run failed. */
    expect(out.text()).toContain("no run of release.yml for v1.2.0 appeared");
    expect(out.text()).not.toContain("run 9");
    /* And nothing was deployed on the strength of it. */
    expect(runner.calls.some((c) => /stack\.mjs deploy/.test(c.command))).toBe(false);
  });

  /** A cancelled run is not an answer either: release.yml makes one per tag. */
  it("ignores the cancelled twin of the tag's run", async () => {
    const runner = new FakeRunner({
      ...healthyWorld(),
      "gh run list --workflow release.yml": {
        code: 0,
        out: JSON.stringify([
          { databaseId: 41, status: "completed", conclusion: "cancelled", headBranch: "v1.2.0", event: "push" },
        ]),
      },
    });
    const out = sink();
    const result = await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));

    expect(result).toMatchObject({ ok: false, stoppedAt: 8 });
    expect(out.text()).toContain("no run of release.yml for v1.2.0 appeared");
  });

  /** A run still going is watched to its end rather than guessed at. */
  it("watches a run that has not finished", async () => {
    const runner = new FakeRunner({
      ...healthyWorld(),
      "gh run list --workflow release.yml": {
        code: 0,
        out: JSON.stringify([
          { databaseId: 77, status: "in_progress", conclusion: null, headBranch: "v1.2.0", event: "release" },
        ]),
      },
      "gh run watch 77": { code: 0, out: "✓ release.yml" },
    });
    const out = sink();
    const result = await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));

    expect(result, out.text()).toMatchObject({ ok: true });
    expect(out.text()).toContain("run 77 (release, v1.2.0) finished green");
  });

  /** A log without the version line is a deploy that did not take. */
  it("stops when the API log does not name the version", async () => {
    const runner = new FakeRunner({
      ...healthyWorld(),
      "ssh docker logs": {
        code: 0,
        out: "vikt-api 1.1.1\nMigrations: 0 applied, 30 recorded\nVAPID ok\nvision: SEES",
      },
    });
    const out = sink();
    const result = await withEnv({}, () => release({ version: "1.2.0", runner, out, root: ROOT }));

    expect(result).toMatchObject({ ok: false, stoppedAt: 11 });
    expect(out.text()).toContain("the version line for 1.2.0");
  });
});

/* ------------------------------------------------- against the stack double -- */

/**
 * The plan step, running the real `stack.mjs` against a Portainer that answers
 * the way the real one does.
 *
 * Small on purpose: what is being tested is that release.mjs builds arguments
 * `stack.mjs` accepts and reads its verdict correctly. `stack-deploy.test.ts`
 * is where the deploy itself is held to what it sends.
 */
describe("the plan step, against a stack double", () => {
  let server: Server;
  let base = "";

  const COMPOSE = execFileSync("git", ["show", "HEAD:infra/docker-compose.portainer.yml"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const REQUIRED = [...COMPOSE.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((m) => m[1] as string);
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      seen.push(url.pathname);
      const json = (code: number, value: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };

      if (url.pathname === "/token") return json(200, { token: "t" });
      if (url.pathname.includes("/manifests/")) {
        res.writeHead(url.pathname.endsWith("/1.2.0") ? 200 : 404);
        return res.end();
      }
      if (url.pathname === "/api/stacks") {
        return json(200, [{ Id: 72, Name: "vikt", EndpointId: 2 }]);
      }
      if (url.pathname === "/api/stacks/72") {
        return json(200, {
          Id: 72,
          Name: "vikt",
          EndpointId: 2,
          Env: [
            ...REQUIRED.map((name) => ({ name, value: "set" })),
            { name: "IMAGE_TAG", value: "1.1.1" },
            { name: "BACKUP_HOST_DIR", value: "/var/backups/vikt/app" },
          ],
        });
      }
      if (url.pathname === "/api/stacks/72/file") return json(200, { StackFileContent: COMPOSE });
      if (url.pathname.startsWith("/api/endpoints/2/docker/containers")) return json(200, []);
      return json(404, { message: "no" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Spawned, never `execFileSync`.
   *
   * The double lives in this process, and a synchronous child blocks the event
   * loop that would answer it: the first version of this test deadlocked for
   * five minutes and reported nothing, because the server could not reply while
   * the test was waiting for the reply. `stack-deploy.test.ts` spawns for the
   * same reason.
   */
  function run(args: string[]): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, "scripts/stack.mjs"), ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORTAINER_URL: base,
          PORTAINER_TOKEN: "ptr_dummy",
          REGISTRY_URL: base,
        },
      });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });
  }

  it("builds arguments stack.mjs accepts, and reads its verdict", async () => {
    const handover = readHandover(STATE, "1.2.0");
    expect(handover.ok).toBe(true);
    if (!handover.ok) return;

    const result = await run(stackArgs("1.2.0", handover, "plan"));

    /* Not a usage error: the arguments release.mjs builds are ones it takes. */
    expect(result.out, result.out).not.toMatch(/^usage:/m);
    expect(seen).toContain("/api/stacks");
    /* The same sentence the step looks for, produced by the real script. */
    expect(result.out, result.out).toMatch(/nothing blocks this deploy/i);
  }, 60_000);
});
