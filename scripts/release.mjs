#!/usr/bin/env node
/**
 * The runbook, as one command (D182).
 *
 *   node scripts/release.mjs 1.2.0
 *   node scripts/release.mjs 1.2.0 --dry-run    # every check, nothing changed
 *
 * `INFRA.md`, "Deploying a version, in order", is the same steps written out
 * for a person. This is not a replacement for that: a self-hoster with no
 * access to this workstation has to be able to do it by hand, and a runbook
 * that exists only as a script is a runbook nobody can read. They are kept step
 * for step, and the manual one names this command beside each step.
 *
 * ## Why a command
 *
 * A deploy was eleven steps in a document, done by hand, at the end of a day.
 * Two of them had already been done wrong in ways that are recorded here: a
 * stack variable set in a panel that the deployed compose never read (D156), and
 * a variable set beside the deploy rather than in it (D174). Both were caught
 * afterwards. The steps that still had no evidence at all were the backup, the
 * restore check, and the Nyheter post: a person did them, or believed they had.
 *
 * ## Stop at the first failure
 *
 * Every step prints what it found and nothing after a failure is attempted.
 * That is the whole control flow, and it is the reason this is worth having: a
 * deploy that has half happened is the state this project can least afford, and
 * the way not to reach it is to never take the next step on a bad answer. The
 * failure names the step and what would have to be true.
 *
 * ## Secrets
 *
 * Nothing sensitive reaches a command line or the output. Stack variables that
 * carry secrets go through `stack.mjs --set-from-env`, which reads them from
 * this shell by name; `PORTAINER_TOKEN` is read by `stack.mjs` itself the same
 * way; and the host is reached over SSH with a key, with `BatchMode=yes` so a
 * missing key **fails** rather than prompting for a password (§7).
 *
 * ## What it needs, all of it by name
 *
 *   VIKT_HOST         user@host for the Docker host, key-based SSH
 *   PORTAINER_TOKEN   read by scripts/stack.mjs
 *   gh                logged in, for the release and its workflow run
 *
 * The host user needs to be in the `docker` group and to be able to write the
 * backup directory. It does **not** need sudo: see INFRA.md, "What the release
 * user needs on the host".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------- the plumbing -- */

/**
 * A step's result. `ok` carries the evidence, `fail` carries what would have to
 * be true and, where there is one, where to set it.
 */
const ok = (evidence) => ({ ok: true, evidence });
const fail = (why, fix = null) => ({ ok: false, why, fix });

class Runner {
  constructor({ dryRun = false } = {}) {
    this.dryRun = dryRun;
  }

  /** A local command. Returns `{ code, out }` with stderr folded into stdout. */
  local(file, args, options = {}) {
    const result = spawnSync(file, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return { code: result.status ?? 1, out };
  }

  /**
   * A command on the Docker host.
   *
   * `BatchMode=yes` and `PasswordAuthentication=no` together are what make
   * "never a password" a property rather than an intention: without a usable
   * key this returns a failure immediately instead of stopping the release at a
   * prompt nobody is watching (§7).
   */
  remote(host, command) {
    return this.local("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "StrictHostKeyChecking=accept-new",
      host,
      command,
    ]);
  }
}

/** The environment, by name, never listed (§7). */
const env = (name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? null : value.trim();
};

/* ---------------------------------------------------------------- STATE.md -- */

/**
 * What STATE.md says this version needs.
 *
 * The handover is already written there in a form a person reads, and this
 * reads the same words rather than a second copy in a config file: the two
 * cannot then disagree, which is the failure D156 is about one level up.
 */
export function readHandover(state, version) {
  const section = state.slice(state.indexOf("## Inför nästa deploy"));
  const end = section.indexOf("\n## ", 4);
  const text = end < 0 ? section : section.slice(0, end);

  if (!text.includes(version)) {
    return { ok: false, why: `STATE.md's "Inför nästa deploy" does not mention ${version}` };
  }

  /* Every `--set NAME=value` the section gives for this version's command. */
  const sets = [...text.matchAll(/--set\s+([A-Z][A-Z0-9_]*)=(\S+)/g)].map((m) => ({
    name: m[1],
    value: m[2],
  }));

  /* And every `--set-from-env NAME`, whose value is never written down. */
  const fromEnv = [...text.matchAll(/--set-from-env\s+([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);

  /**
   * The commit `main` should be at.
   *
   * Named only when `dev` has moved past the release; when the whole of `dev`
   * is the release, `main` fast-forwards to its head and there is nothing to
   * name. Both are legitimate and they need different handling, so the absence
   * is a value rather than a missing one.
   */
  const named = text.match(
    new RegExp(`For \\\`?${version.replace(/\./g, "\\.")}\\\`? it is \\\`([0-9a-f]{7,40})\\\``),
  );

  return { ok: true, sets, fromEnv, commit: named ? named[1] : null };
}

/** The version's Nyheter post, out of STATE.md's own block. */
export function readNewsPost(state, version) {
  const marker = `## Version ${version}`;
  const at = state.indexOf(marker);
  if (at < 0) return null;

  const rest = state.slice(at);
  const end = rest.indexOf("\n```");
  if (end < 0) return null;

  /* `## Version 1.2.0` in STATE.md is the post's own `# Title` here. */
  return `# Version ${version}\n${rest.slice(marker.length, end).trim()}\n`;
}

/* ------------------------------------------------------------------ steps -- */

/**
 * The steps, in the order INFRA.md gives them.
 *
 * Each returns `ok(evidence)` or `fail(why, fix)`, and `context` carries what
 * earlier steps learned. Nothing in here writes to the host or to Portainer
 * when `runner.dryRun` is set, and every step says which of the two it is.
 */
export function buildSteps({ version, runner, root = ROOT }) {
  const context = {};

  return [
    {
      name: "the workstation has what it needs",
      run() {
        const host = env("VIKT_HOST");
        if (host === null) {
          return fail(
            "VIKT_HOST is not set, so there is no host to back up or publish on",
            "set VIKT_HOST to user@host for the Docker host in the workstation's environment, " +
              "with a key-based SSH login for that user (INFRA.md, 'What the release user needs " +
              "on the host')",
          );
        }
        if (env("PORTAINER_TOKEN") === null) {
          return fail(
            "PORTAINER_TOKEN is not set, so the stack cannot be read or deployed",
            "create it in Portainer and set it in the workstation's environment (INFRA.md, " +
              "'The Portainer token')",
          );
        }

        const gh = runner.local("gh", ["auth", "status"]);
        if (gh.code !== 0) {
          return fail("gh is not logged in, so the release and its run cannot be reached", "gh auth login");
        }

        context.host = host;
        /* The host, never the user, and never the token. */
        return ok(`VIKT_HOST set, PORTAINER_TOKEN set, gh authenticated`);
      },
    },

    {
      name: "the working tree is clean and dev is pushed",
      run() {
        const dirty = runner.local("git", ["status", "--porcelain"]);
        if (dirty.code !== 0) return fail("git status failed", dirty.out);
        if (dirty.out !== "") {
          return fail(
            `the working tree has uncommitted changes:\n${dirty.out}`,
            "commit or stash them: a release deploys what is committed, and a tag on a tree " +
              "that does not match the workstation is a tag nobody can reproduce",
          );
        }

        const branch = runner.local("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (branch.out !== "dev") {
          return fail(`on branch ${branch.out}, not dev`, "git switch dev");
        }

        runner.local("git", ["fetch", "origin", "dev"]);
        const ahead = runner.local("git", ["rev-list", "--count", "origin/dev..HEAD"]);
        if (ahead.out !== "0") {
          return fail(`${ahead.out} commit(s) on dev are not pushed`, "git push origin dev");
        }

        const head = runner.local("git", ["rev-parse", "--short", "HEAD"]).out;
        context.head = head;
        return ok(`clean, on dev, pushed, at ${head}`);
      },
    },

    {
      name: "CI is green for that commit",
      run() {
        const run = runner.local("gh", [
          "run",
          "list",
          "--branch",
          "dev",
          "--limit",
          "1",
          "--json",
          "headSha,conclusion,status,displayTitle",
        ]);
        if (run.code !== 0) return fail("could not read CI runs", run.out);

        const [latest] = JSON.parse(run.out || "[]");
        if (!latest) return fail("no CI run found for dev");

        const full = runner.local("git", ["rev-parse", "HEAD"]).out;
        if (latest.headSha !== full) {
          return fail(
            `the newest CI run is for ${String(latest.headSha).slice(0, 7)}, not ${context.head}`,
            "push dev and wait for its run",
          );
        }
        if (latest.status !== "completed" || latest.conclusion !== "success") {
          return fail(`CI for ${context.head} is ${latest.status}/${latest.conclusion}`);
        }
        return ok(`${latest.conclusion} for ${context.head}: ${latest.displayTitle}`);
      },
    },

    {
      name: "back up the database on the host",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run writes nothing to the host");

        const result = runner.remote(context.host, "/srv/vikt/infra/backup.sh");
        if (result.code !== 0) {
          return fail(
            `backup.sh exited ${result.code}:\n${result.out}`,
            "the host user must be in the docker group and able to write the backup directory " +
              "(INFRA.md, 'What the release user needs on the host')",
          );
        }

        const dump = result.out.match(/(\/\S*vikt-\d{8}T\d{6}Z\.dump)/);
        if (!dump) return fail(`backup.sh printed no dump path:\n${result.out}`);

        context.dump = dump[1];
        const size = result.out.match(/database:\s+(\S+)/);
        return ok(`${context.dump}${size ? `, ${size[1]}` : ""}`);
      },
    },

    {
      name: "the backup restores",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run writes nothing to the host");

        const result = runner.remote(
          context.host,
          `/srv/vikt/infra/restore-check.sh ${context.dump}`,
        );
        if (result.code !== 0) {
          return fail(`restore-check.sh exited ${result.code}:\n${result.out}`);
        }
        /* The row counts it printed, which is the evidence that it read. */
        const rows = result.out
          .split("\n")
          .filter((line) => /^\s*\w+\s+\d+\s*$/.test(line))
          .map((line) => line.trim())
          .join(", ");
        if (rows === "") return fail(`restore-check.sh reported no tables:\n${result.out}`);
        return ok(rows);
      },
    },

    {
      name: "main is at the release commit",
      run() {
        const handover = readHandover(readFileSync(path.join(root, "STATE.md"), "utf8"), version);
        if (!handover.ok) return fail(handover.why);
        context.handover = handover;

        const target = handover.commit ?? runner.local("git", ["rev-parse", "HEAD"]).out;
        context.target = target;

        if (runner.dryRun) return ok(`would fast-forward main to ${target.slice(0, 7)}`);

        runner.local("git", ["fetch", "origin", "main"]);
        const behind = runner.local("git", ["rev-list", "--count", `origin/main..${target}`]);
        const ahead = runner.local("git", ["rev-list", "--count", `${target}..origin/main`]);
        if (ahead.out !== "0") {
          return fail(
            `main has ${ahead.out} commit(s) that ${target.slice(0, 7)} does not, so this is not a fast-forward`,
            "reconcile main and dev by hand before releasing",
          );
        }
        if (behind.out === "0") return ok(`main is already at ${target.slice(0, 7)}`);

        const push = runner.local("git", ["push", "origin", `${target}:refs/heads/main`]);
        if (push.code !== 0) return fail(`could not fast-forward main:\n${push.out}`);
        return ok(`main fast-forwarded ${behind.out} commit(s) to ${target.slice(0, 7)}`);
      },
    },

    {
      name: "the tag is published",
      run() {
        const tag = `v${version}`;
        const existing = runner.local("gh", ["release", "view", tag, "--json", "tagName"]);
        if (existing.code === 0) return ok(`${tag} already exists`);

        if (runner.dryRun) return ok(`would create release ${tag} on ${context.target.slice(0, 7)}`);

        const notes = readNewsPost(readFileSync(path.join(root, "STATE.md"), "utf8"), version);
        if (notes === null) {
          return fail(`STATE.md has no "## Version ${version}" block to release from`);
        }

        const file = path.join(mkdtempSync(path.join(tmpdir(), "vikt-release-")), "notes.md");
        writeFileSync(file, notes, "utf8");
        try {
          const created = runner.local("gh", [
            "release",
            "create",
            tag,
            "--target",
            context.target,
            "--title",
            version,
            "--notes-file",
            file,
          ]);
          if (created.code !== 0) return fail(`gh release create failed:\n${created.out}`);
          return ok(`${tag} created on ${context.target.slice(0, 7)}`);
        } finally {
          rmSync(path.dirname(file), { recursive: true, force: true });
        }
      },
    },

    {
      name: "the release workflow is green",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run creates no tag to watch");

        const watch = runner.local("gh", [
          "run",
          "list",
          "--workflow",
          "release.yml",
          "--limit",
          "1",
          "--json",
          "databaseId,status,conclusion",
        ]);
        if (watch.code !== 0) return fail("could not read the release workflow", watch.out);
        const [run] = JSON.parse(watch.out || "[]");
        if (!run) return fail("no release workflow run found for the tag");

        if (run.status !== "completed") {
          const waited = runner.local("gh", ["run", "watch", String(run.databaseId), "--exit-status"]);
          if (waited.code !== 0) return fail(`the release workflow failed:\n${waited.out}`);
          return ok(`run ${run.databaseId} finished green`);
        }
        if (run.conclusion !== "success") return fail(`run ${run.databaseId} is ${run.conclusion}`);
        return ok(`run ${run.databaseId} is ${run.conclusion}`);
      },
    },

    {
      name: "the deploy plan is clean",
      run() {
        const args = stackArgs(version, context.handover, "plan");
        const plan = runner.local("node", [path.join(root, "scripts/stack.mjs"), ...args]);
        if (plan.code !== 0) return fail(`plan exited ${plan.code}:\n${plan.out}`);
        if (!/nothing blocks this deploy/i.test(plan.out)) {
          return fail(`the plan did not end "nothing blocks this deploy":\n${plan.out}`);
        }
        if (/missing|not set/i.test(plan.out)) {
          return fail(`the plan reports something missing:\n${plan.out}`);
        }
        return ok("nothing blocks this deploy");
      },
    },

    {
      name: "the stack is deployed",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run does not deploy");

        const args = [...stackArgs(version, context.handover, "deploy"), "--yes"];
        const deploy = runner.local("node", [path.join(root, "scripts/stack.mjs"), ...args]);
        if (deploy.code !== 0) return fail(`deploy exited ${deploy.code}:\n${deploy.out}`);
        return ok(deploy.out.split("\n").slice(-4).join("\n"));
      },
    },

    {
      name: "the API came up on the new version",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run deploys nothing to check");

        const log = runner.remote(context.host, "docker logs --tail 200 vikt-api-1 2>&1");
        if (log.code !== 0) return fail(`could not read the API log:\n${log.out}`);

        const missing = [];
        if (!log.out.includes(version)) missing.push(`the version line for ${version}`);
        if (!/Migrations:\s*\d+ applied/i.test(log.out)) missing.push("the migrations line");
        if (!/VAPID/i.test(log.out)) missing.push("the VAPID line");
        if (!/vision/i.test(log.out)) missing.push("the vision self-test line");
        if (missing.length > 0) {
          return fail(`the API log is missing ${missing.join(", ")}:\n${log.out.slice(-1200)}`);
        }

        const lines = log.out
          .split("\n")
          .filter((line) => /version|Migrations:|VAPID|vision/i.test(line))
          .slice(-6)
          .join("\n");
        return ok(lines);
      },
    },

    {
      name: "the site answers from outside",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run deploys nothing to check");

        const base = env("PUBLIC_BASE_URL") ?? "https://vikt.lundstream.net";
        const health = runner.local("curl", ["-sS", "-o", "-", "-w", "\\n%{http_code}", `${base}/api/health`]);
        const landing = runner.local("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", `${base}/`]);

        const healthCode = health.out.trim().split("\n").at(-1);
        if (healthCode !== "200") return fail(`${base}/api/health answered ${healthCode}`);
        if (landing.out.trim() !== "200") return fail(`${base}/ answered ${landing.out.trim()}`);
        return ok(`${base}/api/health 200, ${base}/ 200`);
      },
    },

    {
      name: "the Nyheter post is published",
      run() {
        if (runner.dryRun) return ok("skipped: --dry-run publishes nothing");

        const notes = readNewsPost(readFileSync(path.join(root, "STATE.md"), "utf8"), version);
        if (notes === null) return fail(`STATE.md has no "## Version ${version}" block`);

        /*
          Written on the host and read by the container, rather than passed as
          an argument: a release post is a page of markdown, and a page of
          markdown on a command line is a quoting bug waiting to happen.
        */
        const remotePath = `/tmp/vikt-news-${version}.md`;
        const write = runner.remote(
          context.host,
          `cat > ${remotePath} <<'VIKT_NEWS_EOF'\n${notes}\nVIKT_NEWS_EOF`,
        );
        if (write.code !== 0) return fail(`could not write the post to the host:\n${write.out}`);

        const published = runner.remote(
          context.host,
          `docker cp ${remotePath} vikt-api-1:${remotePath} && ` +
            `docker exec vikt-api-1 pnpm --filter api news:publish -- --file ${remotePath}; ` +
            `rm -f ${remotePath}`,
        );
        if (published.code !== 0) return fail(`news:publish exited ${published.code}:\n${published.out}`);
        if (!/published|already published/.test(published.out)) {
          return fail(`news:publish said nothing recognisable:\n${published.out}`);
        }
        return ok(published.out.split("\n").filter(Boolean).at(-1));
      },
    },
  ];
}

/** `stack.mjs`'s arguments for this version, from STATE.md's own list. */
export function stackArgs(version, handover, command) {
  const args = [command, version, "--release-file"];
  for (const { name, value } of handover.sets) args.push("--set", `${name}=${value}`);
  /* Anything sensitive by name only: the value never reaches a command line. */
  for (const name of handover.fromEnv) args.push("--set-from-env", name);
  return args;
}

/* ------------------------------------------------------------------- main -- */

export async function release({ version, runner, out = process.stdout, root = ROOT }) {
  const steps = buildSteps({ version, runner, root });
  out.write(`releasing ${version}${runner.dryRun ? " (dry run)" : ""}\n\n`);

  for (const [index, step] of steps.entries()) {
    const number = `${index + 1}/${steps.length}`;
    let result;
    try {
      result = step.run();
    } catch (error) {
      result = fail(`${error?.message ?? error}`);
    }

    if (result.ok) {
      out.write(`ok   ${number} ${step.name}\n`);
      for (const line of String(result.evidence).split("\n")) out.write(`       ${line}\n`);
      continue;
    }

    out.write(`FAIL ${number} ${step.name}\n`);
    for (const line of String(result.why).split("\n")) out.write(`       ${line}\n`);
    if (result.fix) {
      out.write(`\n     what would have to be true:\n`);
      for (const line of String(result.fix).split("\n")) out.write(`       ${line}\n`);
    }
    out.write(`\nstopped at step ${number}. Nothing after it was attempted.\n`);
    return { ok: false, stoppedAt: index + 1, step: step.name };
  }

  out.write(`\n${version} is live, and every step above said so.\n`);
  return { ok: true, stoppedAt: null };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const version = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    process.stderr.write("usage: node scripts/release.mjs <version> [--dry-run]\n");
    process.exitCode = 1;
  } else if (!existsSync(path.join(ROOT, "STATE.md"))) {
    process.stderr.write("STATE.md is not where it should be; run this from the repository.\n");
    process.exitCode = 1;
  } else {
    const result = await release({ version, runner: new Runner({ dryRun }) });
    if (!result.ok) process.exitCode = 1;
  }
}

export { Runner, ok, fail };
export const __test = { execFileSync };
