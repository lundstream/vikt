#!/usr/bin/env node
/**
 * Deploy a version to the Portainer stack, without a password and without the
 * panel (D164).
 *
 *   node scripts/stack.mjs plan 1.1.1              # what would change; changes nothing
 *   node scripts/stack.mjs deploy 1.1.1            # the same, then stops
 *   node scripts/stack.mjs deploy 1.1.1 --yes      # sets the tag, pulls, redeploys, waits
 *
 *   --set NAME=value     set a stack variable in the same update as the deploy
 *   --set-from-env NAME  the same, with the value read from this shell
 *   --unset NAME         remove a stack variable
 *   --repo local/        a workstation build loaded onto the host (INFRA.md)
 *   --ref v1.1.1         which commit's compose file to compare with (default v<version>)
 *   --keep-file          the stack file differs from the release's: deploy with it anyway
 *   --release-file       the stack file differs from the release's: replace it
 *
 * Until this existed a deploy was a person in Portainer's variables panel,
 * typing a tag, remembering to tick "Re-pull image", and not seeing that
 * `IMAGE_REPO` still said `local/` from the deploy before. Every one of those
 * has happened (D156, INFRA.md step 5). `plan` asks each question out loud
 * before anything moves, and `deploy` refuses when one of the answers is wrong:
 *
 * - **The stack file reads `IMAGE_TAG`.** Against a file that does not, setting
 *   the variable changes nothing and Portainer reports success (D156).
 * - **The stack file is the release's**, or the operator has said which to use.
 * - **No variable the release requires is unset**, and any it adds are named.
 * - **The images exist where the stack will look**: anonymously on GHCR, the way
 *   the Docker host pulls (D160), or on the host for a local build.
 *
 * ## Setting variables (D174)
 *
 * Until this existed, "set `BACKUP_HOST_DIR`" was a step in the runbook that
 * meant opening the panel, typing into it, and updating the stack a second
 * time. Two updates means two restarts, and the first of them runs the new
 * image without the variable it needs.
 *
 * `--set` merges into what the stack already has and the whole list goes back
 * in the **same** update as the compose file and the tag, so a variable is
 * never set in a restart of its own. Nothing is dropped unless `--unset` names
 * it, and the script refuses to send a list that has lost a variable the stack
 * had: Portainer's update replaces the environment wholesale, so a merge bug
 * would silently delete `SECRET_KEY`.
 *
 * **A secret is never an argument.** A name containing SECRET, PASS, KEY or
 * TOKEN is refused on the command line and has to come through
 * `--set-from-env`, which reads it from this shell and never prints it: an
 * argument is in the shell history, in the process list, and in whatever is
 * recording the session (§7).
 *
 * **No stack variable's value is ever printed except `IMAGE_REPO` and
 * `IMAGE_TAG`.** The stack holds `SECRET_KEY`, `SESSION_SECRET`, the database
 * password and the VAPID private key, and Portainer echoes them all back in
 * every stack response. Names are printed; values stay in memory, and are sent
 * back unchanged in the update, which is the only place they go.
 * `stack-deploy.test.ts` runs this against a server that returns them and
 * fails on any of them, or the token, reaching stdout or stderr.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { err, out, portainer, request } from "./portainer.mjs";

const STACK_NAME = process.env.STACK_NAME ?? "vikt";
const COMPOSE_PATH = "infra/docker-compose.portainer.yml";

/** What `IMAGE_REPO` is set to for a registry deploy: the compose's own default. */
const REGISTRY_REPO = "ghcr.io/lundstream/";
/** Overridable only so the test can stand a registry up locally. */
const REGISTRY_URL = process.env.REGISTRY_URL ?? "https://ghcr.io";

const IMAGES = { api: "vikt-api", nginx: "vikt-web" };

/** The only variables whose values this script prints. */
const SHOWN = new Set(["IMAGE_REPO", "IMAGE_TAG"]);

const POLL_MS = Number(process.env.STACK_POLL_MS ?? 3000);
const WAIT_MS = Number(process.env.STACK_WAIT_MS ?? 240_000);

/* ----------------------------------------------------------- reading -- */

async function must(path) {
  const result = await portainer(path);
  if (result === null) throw new Error(`could not read ${path}`);
  return result;
}

async function readStack() {
  const stacks = await must("/api/stacks");
  const found = stacks.find((stack) => stack.Name === STACK_NAME);
  if (!found) throw new Error(`no stack named ${STACK_NAME} is visible to this account`);

  const stack = await must(`/api/stacks/${found.Id}`);
  const file = await must(`/api/stacks/${found.Id}/file`);
  return {
    id: stack.Id,
    endpoint: stack.EndpointId,
    vars: stack.Env ?? [],
    file: file.StackFileContent ?? "",
  };
}

/** Every `${NAME…}` a compose file reads, and which of them it refuses without. */
export function composeVariables(text) {
  const all = new Set();
  const required = new Set();
  for (const match of text.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:?[-?])?/g)) {
    all.add(match[1]);
    if (match[2] === ":?" || match[2] === "?") required.add(match[1]);
  }
  return { all, required };
}

function committedCompose(ref) {
  try {
    return execFileSync("git", ["show", `${ref}:${COMPOSE_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

const normalise = (text) => text.replace(/\r\n/g, "\n").trimEnd();

/**
 * Whether GHCR hands this image out without credentials, which is how the
 * Docker host asks (D160). A private package fails at the pull-token endpoint,
 * a missing tag at the manifest, so both are asked.
 */
async function registryHas(image, tag) {
  const repository = `${REGISTRY_REPO.replace(/^ghcr\.io\//, "")}${image}`;
  try {
    const grant = await fetch(
      `${REGISTRY_URL}/token?scope=repository:${repository}:pull&service=ghcr.io`,
    );
    if (!grant.ok) return `the pull-token endpoint answered ${grant.status}, so it is not public`;
    const { token: bearer } = await grant.json();

    const manifest = await fetch(`${REGISTRY_URL}/v2/${repository}/manifests/${tag}`, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    });
    return manifest.ok ? null : `the manifest for :${tag} answered ${manifest.status}`;
  } catch (error) {
    return `the registry could not be reached (${error instanceof Error ? error.message : error})`;
  }
}

async function hostHas(endpoint, reference) {
  const images = await must(`/api/endpoints/${endpoint}/docker/images/json`);
  return images.some((image) => (image.RepoTags ?? []).includes(reference))
    ? null
    : `${reference} is not on the host; load it first (INFRA.md, "Building on the workstation")`;
}

async function containers(endpoint) {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${STACK_NAME}`] }),
  );
  const list = await must(`/api/endpoints/${endpoint}/docker/containers/json?all=1&filters=${filters}`);
  const byService = {};
  for (const summary of list) {
    const service = summary.Labels?.["com.docker.compose.service"];
    if (!service) continue;
    const detail = await must(`/api/endpoints/${endpoint}/docker/containers/${summary.Id}/json`);
    byService[service] = {
      id: summary.Id,
      name: (summary.Names?.[0] ?? service).replace(/^\//, ""),
      image: detail.Config?.Image ?? summary.Image,
      state: detail.State?.Status ?? summary.State,
      health: detail.State?.Health?.Status ?? "none",
      startedAt: detail.State?.StartedAt ?? "",
    };
  }
  return byService;
}

/* ---------------------------------------------------------- the plan -- */

/**
 * Names that may not be given a value on the command line (D174).
 *
 * An argument lives in the shell's history, in the process list while it runs,
 * and in whatever is recording the session. §7's rule is that a credential is
 * read from the environment and never typed where something can keep it, so
 * these come through `--set-from-env`.
 */
const SECRET_NAME = /SECRET|PASS|KEY|TOKEN/i;

export function isSecretName(name) {
  return SECRET_NAME.test(name);
}

/**
 * The variables the update sends: every existing one with its value untouched,
 * in its order, the two this script owns set, and whatever `--set` and
 * `--unset` asked for.
 *
 * **Portainer's stack update replaces the environment wholesale.** What this
 * returns is the complete list, so anything missing from it is deleted from the
 * stack, which is why `assertNothingDropped` exists below rather than a comment
 * asking the next person to be careful.
 */
export function nextVariables(current, { repo, version, set = {}, unset = [] }) {
  const removing = new Set(unset);
  const wanted = { IMAGE_REPO: repo, IMAGE_TAG: version, ...set };

  const next = current
    .filter(({ name }) => !removing.has(name))
    .map(({ name, value }) => (name in wanted ? { name, value: wanted[name] } : { name, value }));

  for (const [name, value] of Object.entries(wanted)) {
    if (removing.has(name)) continue;
    if (!next.some((entry) => entry.name === name)) next.push({ name, value });
  }

  return next;
}

/**
 * Nothing the stack has may vanish from the list being sent, unless it was
 * named to `--unset`.
 *
 * The failure this prevents is the worst one available here: the update sends
 * the whole environment, so a list built wrongly does not fail, it deletes
 * `SECRET_KEY` and the database password and then restarts the stack.
 */
export function assertNothingDropped(current, next, unset = []) {
  const removing = new Set(unset);
  const have = new Set(next.map((entry) => entry.name));
  const lost = current
    .map((entry) => entry.name)
    .filter((name) => !have.has(name) && !removing.has(name));

  if (lost.length > 0) {
    throw new Error(
      `the update would drop ${lost.join(", ")} from the stack. ` +
        "Portainer replaces the whole environment, so this would delete them. " +
        "Name them to --unset if that is what you meant.",
    );
  }
  return next;
}

/**
 * What `--set`, `--set-from-env` and `--unset` add up to, with the values
 * resolved and never printed.
 */
export function resolveVariables(options, env = process.env) {
  const set = {};

  for (const pair of options.set ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`--set wants NAME=value, got ${pair}`);
    const name = pair.slice(0, at);
    if (isSecretName(name)) {
      throw new Error(
        `${name} looks like a secret, so it cannot be given on the command line. ` +
          `Put it in this shell and use --set-from-env ${name}.`,
      );
    }
    set[name] = pair.slice(at + 1);
  }

  for (const name of options.fromEnv ?? []) {
    const value = env[name];
    if (value === undefined || value === "") {
      throw new Error(`${name} is not set in this shell, so --set-from-env ${name} has nothing to send.`);
    }
    set[name] = value;
  }

  return { set, unset: options.unset ?? [] };
}

async function plan(version, options) {
  const blockers = [];
  const stack = await readStack();
  const setNames = new Set(stack.vars.filter((v) => v.value !== "").map((v) => v.name));
  const valueOf = (name) => stack.vars.find((v) => v.name === name)?.value;

  out(`stack      ${STACK_NAME} (id ${stack.id}, endpoint ${stack.endpoint})`);

  const running = composeVariables(stack.file);
  const readsTag = running.all.has("IMAGE_TAG");
  const readsRepo = running.all.has("IMAGE_REPO");
  out(`stack file reads IMAGE_TAG: ${readsTag ? "yes" : "NO"}, IMAGE_REPO: ${readsRepo ? "yes" : "NO"}`);
  if (!readsTag) blockers.push("the stack file does not read IMAGE_TAG, so setting it would change nothing (D156)");

  let ref = options.ref ?? `v${version}`;
  let release = committedCompose(ref);
  if (release === null) {
    out(`           ${ref} does not exist yet; comparing with HEAD instead`);
    ref = "HEAD";
    release = committedCompose(ref);
  }

  let fileToSend = stack.file;
  if (release === null) {
    blockers.push(`${COMPOSE_PATH} could not be read from git`);
  } else if (normalise(release) === normalise(stack.file)) {
    out(`           equals ${COMPOSE_PATH} at ${ref}`);
  } else if (options.releaseFile) {
    out(`           differs from ${COMPOSE_PATH} at ${ref}; --release-file replaces it`);
    fileToSend = release;
  } else if (options.keepFile) {
    out(`           differs from ${COMPOSE_PATH} at ${ref}; --keep-file keeps the stack's`);
  } else {
    out(`           DIFFERS from ${COMPOSE_PATH} at ${ref}`);
    blockers.push("the stack file is not the release's: pass --release-file or --keep-file");
  }

  const releaseVars = composeVariables(release ?? stack.file);
  const missingRequired = [...releaseVars.required].filter(
    (name) => !setNames.has(name) && !(name === "IMAGE_TAG"),
  );
  const added = [...releaseVars.all].filter((name) => !running.all.has(name) && !setNames.has(name));

  out(`variables  ${stack.vars.length} set in the stack (names only; values are not printed)`);
  out(`           required by the release and not set: ${missingRequired.join(", ") || "none"}`);
  out(`           new in the release and not set: ${added.join(", ") || "none"}`);
  if (missingRequired.length > 0) blockers.push(`set ${missingRequired.join(", ")} first`);

  const repo = options.repo ?? REGISTRY_REPO;

  /**
   * The variables this run is asked to change, by name (D174).
   *
   * Names only, and that is the whole reporting rule: the values are a host
   * directory today and could be anything tomorrow, and a plan that printed
   * them would print whatever somebody passed to `--set-from-env`.
   */
  const { set, unset } = resolveVariables(options);
  const known = new Map(stack.vars.map((entry) => [entry.name, entry.value]));
  const changing = Object.keys(set).map((name) =>
    !known.has(name)
      ? `${name} (new)`
      : known.get(name) === set[name]
        ? `${name} (unchanged)`
        : `${name} (changed)`,
  );
  const removing = unset.filter((name) => known.has(name));
  const absent = unset.filter((name) => !known.has(name));

  if (changing.length > 0) out(`           setting: ${changing.join(", ")}`);
  if (removing.length > 0) out(`           unsetting: ${removing.join(", ")}`);
  for (const name of absent) out(`           ${name} is not set in the stack; --unset does nothing`);

  const nextVars = assertNothingDropped(
    stack.vars,
    nextVariables(stack.vars, { repo, version, set, unset }),
    unset,
  );

  out("change");
  for (const [name, value] of Object.entries({ IMAGE_REPO: repo, IMAGE_TAG: version })) {
    if (!SHOWN.has(name)) continue;
    const before = valueOf(name);
    const shownBefore = before === undefined ? "(unset)" : before === "" ? "(empty)" : before;
    out(`           ${name.padEnd(10)} ${shownBefore} -> ${value}${before === value ? "  (unchanged)" : ""}`);
  }

  for (const image of Object.values(IMAGES)) {
    const reference = `${repo}${image}:${version}`;
    const problem =
      repo === REGISTRY_REPO ? await registryHas(image, version) : await hostHas(stack.endpoint, reference);
    const where = repo === REGISTRY_REPO ? "anonymously pullable" : "present on the host";
    out(`image      ${reference} ${problem === null ? where : `NOT ${where}: ${problem}`}`);
    if (problem !== null) blockers.push(`${reference}: ${problem}`);
  }

  const now = await containers(stack.endpoint);
  for (const [service, c] of Object.entries(now)) {
    out(`running    ${service.padEnd(8)} ${c.image}  ${c.state}${c.health === "none" ? "" : `, ${c.health}`}`);
  }

  out("");
  if (blockers.length > 0) {
    for (const blocker of blockers) err(`blocked: ${blocker}\n`);
  } else {
    out("nothing blocks this deploy");
  }

  return {
    stack,
    blockers,
    repo,
    fileToSend,
    // Computed here so `deploy` sends exactly what `plan` described (D174).
    nextVars,
    previous: valueOf("IMAGE_TAG"),
    previousRepo: valueOf("IMAGE_REPO"),
  };
}

/* -------------------------------------------------------- the deploy -- */

/** Docker's log stream for a container without a TTY: 8-byte frame headers. */
export function demux(buffer) {
  let text = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    text += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return text;
}

/**
 * The lines INFRA.md step 6 reads, and nothing else from the log.
 *
 * `api build` is first in the runbook and was missing here (D169): the version
 * is the answer to "is this the new image", and a deploy that printed every
 * line except that one made the operator go and look somewhere else.
 */
const LOG_LINES = /api build|migration|starting api|api up|deployment modes|vapid|vision|smtp|"level":(40|50|60)|\berror\b|\bwarn/i;

async function deploy(version, options) {
  const planned = await plan(version, options);
  if (planned.blockers.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (!options.yes) {
    out("nothing was changed. Run again with --yes to deploy.");
    return;
  }

  const { stack, repo } = planned;
  const since = Math.floor(Date.now() / 1000) - 5;

  out("");
  out(`updating the stack with IMAGE_TAG=${version}, pulling images`);
  const updated = await portainer(`/api/stacks/${stack.id}?endpointId=${stack.endpoint}`, {
    method: "PUT",
    body: {
      stackFileContent: planned.fileToSend,
      // The compose file, the tag and every variable in one update: a
      // variable set in a second update is a restart that ran without it.
      env: planned.nextVars,
      prune: false,
      pullImage: true,
    },
  });
  if (updated === null) {
    err("the stack update was refused; nothing was deployed\n");
    process.exitCode = 1;
    return;
  }

  const wantApi = `${repo}${IMAGES.api}:${version}`;
  const wantWeb = `${repo}${IMAGES.nginx}:${version}`;
  const deadline = Date.now() + WAIT_MS;
  let last = "";
  let now = {};

  while (Date.now() < deadline) {
    now = await containers(stack.endpoint);
    const api = now.api;
    const web = now.nginx;
    const line = `api ${api?.image ?? "?"} ${api?.state ?? "?"}/${api?.health ?? "?"}; web ${web?.image ?? "?"} ${web?.state ?? "?"}`;
    if (line !== last) out(`  ${line}`);
    last = line;

    if (
      api?.image === wantApi &&
      api.state === "running" &&
      api.health === "healthy" &&
      web?.image === wantWeb &&
      web.state === "running"
    ) {
      break;
    }
    await sleep(POLL_MS);
  }

  if (now.api) {
    const logs = await request(
      `/api/endpoints/${stack.endpoint}/docker/containers/${now.api.id}/logs?stdout=1&stderr=1&since=${since}`,
    );
    if (logs.ok) {
      const lines = demux(Buffer.from(await logs.arrayBuffer()))
        .split("\n")
        .filter((entry) => LOG_LINES.test(entry));
      out("");
      out("api log, the lines INFRA.md step 6 reads:");
      for (const entry of lines) out(`  ${entry.trimEnd()}`);
    }
  }

  const done = now.api?.image === wantApi && now.api?.health === "healthy" && now.nginx?.image === wantWeb;
  out("");
  if (done) {
    out(`deployed ${version}: both containers on the new image, the API healthy`);
  } else {
    err(`not healthy on ${version} within ${Math.round(WAIT_MS / 1000)} s. Read the log in Portainer.\n`);
    if (planned.previous) {
      const back = planned.previousRepo && planned.previousRepo !== REGISTRY_REPO ? ` --repo ${planned.previousRepo}` : "";
      err(`rollback: node scripts/stack.mjs deploy ${planned.previous}${back} --keep-file --yes\n`);
    }
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ cli -- */

function parse(argv) {
  const [command, version, ...rest] = argv;
  const options = { yes: false, keepFile: false, releaseFile: false, set: [], fromEnv: [], unset: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--yes") options.yes = true;
    else if (arg === "--keep-file") options.keepFile = true;
    else if (arg === "--release-file") options.releaseFile = true;
    else if (arg === "--repo") options.repo = rest[(i += 1)];
    else if (arg === "--ref") options.ref = rest[(i += 1)];
    else if (arg === "--set") options.set.push(rest[(i += 1)]);
    else if (arg === "--set-from-env") options.fromEnv.push(rest[(i += 1)]);
    else if (arg === "--unset") options.unset.push(rest[(i += 1)]);
    else throw new Error(`unknown option ${arg}`);
  }
  return { command, version, options };
}

const USAGE =
  "usage: stack.mjs plan|deploy <x.y.z> [--yes] [--repo local/] [--ref v1.2.3]\n" +
  "       [--keep-file|--release-file] [--set NAME=value] [--set-from-env NAME] [--unset NAME]\n";

try {
  const { command, version, options } = parse(process.argv.slice(2));
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !["plan", "deploy"].includes(command)) {
    err(USAGE);
    process.exitCode = 2;
  } else if (options.keepFile && options.releaseFile) {
    err("--keep-file and --release-file contradict each other\n");
    process.exitCode = 2;
  } else if (command === "plan") {
    const { blockers } = await plan(version, options);
    process.exitCode = blockers.length > 0 ? 1 : 0;
  } else {
    await deploy(version, options);
  }
} catch (error) {
  err(`stack: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
