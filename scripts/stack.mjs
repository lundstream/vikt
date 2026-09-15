#!/usr/bin/env node
/**
 * Deploy a version to the Portainer stack, without a password and without the
 * panel (D164).
 *
 *   node scripts/stack.mjs plan 1.1.1              # what would change; changes nothing
 *   node scripts/stack.mjs deploy 1.1.1            # the same, then stops
 *   node scripts/stack.mjs deploy 1.1.1 --yes      # sets the tag, pulls, redeploys, waits
 *
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
 * The variables the update sends: every existing one with its value untouched,
 * in its order, and the two this script owns set.
 */
export function nextVariables(current, { repo, version }) {
  const wanted = { IMAGE_REPO: repo, IMAGE_TAG: version };
  const next = current.map(({ name, value }) =>
    name in wanted ? { name, value: wanted[name] } : { name, value },
  );
  for (const [name, value] of Object.entries(wanted)) {
    if (!next.some((entry) => entry.name === name)) next.push({ name, value });
  }
  return next;
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
      env: nextVariables(stack.vars, { repo, version }),
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
  const options = { yes: false, keepFile: false, releaseFile: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--yes") options.yes = true;
    else if (arg === "--keep-file") options.keepFile = true;
    else if (arg === "--release-file") options.releaseFile = true;
    else if (arg === "--repo") options.repo = rest[(i += 1)];
    else if (arg === "--ref") options.ref = rest[(i += 1)];
    else throw new Error(`unknown option ${arg}`);
  }
  return { command, version, options };
}

const USAGE = "usage: stack.mjs plan|deploy <x.y.z> [--yes] [--repo local/] [--ref v1.2.3] [--keep-file|--release-file]\n";

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
