#!/usr/bin/env node
/**
 * The scripts that run from the host rather than from an image (D163).
 *
 * Everything else in this installation reaches production inside an image, so
 * its version is a tag and its checksum is a digest. These do not: `backup.sh`
 * and `restore-check.sh` are files on the Docker host, copied there by hand, and
 * nothing said which version was there or whether any was. When it was finally
 * looked at, none was — and the repository's own fix to `backup.sh`'s prune
 * (D159) had been written for a host copy that did not exist.
 *
 *   node scripts/host-scripts.mjs check     # repository against host, by sha256
 *   node scripts/host-scripts.mjs install   # copy the committed files, then check
 *
 * **The repository side is the committed blob, never the working tree.** On the
 * workstation this is developed on, 162 tracked files have CRLF working copies
 * while their blobs are LF, `backup.sh` among them. A working copy sent to a
 * Linux host would fail at its first line with "bad interpreter", and a checksum
 * of it would never equal anything that had been installed correctly.
 *
 * **The cron line is reported, not installed.** Since D103 the schedule is in
 * the app. Installing the line starts a second, unencrypted nightly dump of every
 * user's data onto the host, which is a decision about data rather than a sync,
 * so `check` says whether it is there and `install` never adds it.
 *
 * Reads `PORTAINER_TOKEN` through `scripts/portainer.mjs`, and prints only
 * through its redacting `out` and `err` (§7).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { err, out, request } from "./portainer.mjs";

const ENDPOINT = 2;
const HOST_DIR = "/srv/vikt/infra";

/** The files, as repository paths. The host copy is the basename in HOST_DIR. */
export const HOST_FILES = ["infra/backup.sh", "infra/restore-check.sh"];

/** `docs/backup.md`'s schedule, in `/etc/cron.d` form, which names the user. */
export const CRON_FILE = "/etc/cron.d/vikt-backup";
export const CRON_LINE =
  "17 3 * * * root /srv/vikt/infra/backup.sh >> /var/log/vikt-backup.log 2>&1";

/** The image the stack already runs, by digest, so a check never pulls anything. */
const HELPER_IMAGE =
  "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

export function committed(file) {
  return execFileSync("git", ["show", `HEAD:${file}`], { maxBuffer: 16 * 1024 * 1024 });
}

export function commitShort() {
  return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
}

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * A ustar archive, which is what Docker's archive endpoint takes.
 *
 * Written out rather than pulled in: forty lines against a dependency whose only
 * job here would be this. Owner is root and the mode is given, because the files
 * have to be executable by cron and owned by the user cron runs them as.
 */
export function tar(entries) {
  const parts = [];
  const now = Math.floor(Date.now() / 1000);

  for (const { name, data, mode } of entries) {
    const header = Buffer.alloc(512, 0);
    const field = (value, offset, length) => header.write(value, offset, length, "ascii");

    field(name, 0, 100);
    field(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
    field("0000000\0", 108, 8);
    field("0000000\0", 116, 8);
    field(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    field(`${now.toString(8).padStart(11, "0")}\0`, 136, 12);
    field("        ", 148, 8);
    field("0", 156, 1);
    field("ustar\0", 257, 6);
    field("00", 263, 2);

    let sum = 0;
    for (const byte of header) sum += byte;
    field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);

    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }

  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function docker(apiPath, options) {
  return request(`/api/endpoints/${ENDPOINT}/docker${apiPath}`, options);
}

/** Run one shell command in a throwaway container with host paths bound in. */
async function onHost(cmd, binds, { keepAlive = false } = {}) {
  const created = await docker("/containers/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Image: HELPER_IMAGE,
      Entrypoint: [],
      Cmd: ["sh", "-c", keepAlive ? `${cmd} && sleep 300` : cmd],
      Tty: true,
      HostConfig: { Binds: binds },
    }),
  });
  if (!created.ok) throw new Error(`could not create the helper: HTTP ${created.status}`);
  const { Id } = await created.json();

  const started = await docker(`/containers/${Id}/start`, { method: "POST" });
  if (!started.ok && started.status !== 304) {
    await docker(`/containers/${Id}?force=1`, { method: "DELETE" });
    throw new Error(`could not start the helper: HTTP ${started.status}`);
  }

  if (keepAlive) return { id: Id };

  try {
    const waited = await (await docker(`/containers/${Id}/wait`, { method: "POST" })).json();
    const logs = await (await docker(`/containers/${Id}/logs?stdout=1&stderr=1`)).text();
    return { code: waited.StatusCode, output: logs };
  } finally {
    await docker(`/containers/${Id}?force=1`, { method: "DELETE" });
  }
}

/** What is on the host now: each file's sha256 or `missing`, and the cron file. */
async function hostState() {
  const lines = HOST_FILES.map((file) => {
    const name = path.posix.basename(file);
    return `if [ -f /hs/vikt/infra/${name} ]; then echo "${name} $(sha256sum /hs/vikt/infra/${name} | cut -d' ' -f1)"; else echo "${name} missing"; fi`;
  });
  lines.push('echo "CRON-BEGIN"; cat /he/cron.d/vikt-backup 2>/dev/null; echo "CRON-END"');

  const { code, output } = await onHost(lines.join("; "), ["/srv:/hs:ro", "/etc:/he:ro"]);
  if (code !== 0) throw new Error(`reading the host failed with exit ${code}`);

  const text = output.replace(/\r/g, "");
  const files = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^(\S+\.sh) (missing|[0-9a-f]{64})$/);
    if (match) files.set(match[1], match[2]);
  }
  const cron = text.split("CRON-BEGIN")[1]?.split("CRON-END")[0]?.trim() ?? "";
  return { files, cron };
}

export async function check({ requireCron = false } = {}) {
  const { files, cron } = await hostState();
  let mismatched = 0;

  out(`repository: HEAD ${commitShort()}, committed blobs`);
  out(`host:       ${HOST_DIR}`);
  out("");

  for (const file of HOST_FILES) {
    const name = path.posix.basename(file);
    const expected = sha256(committed(file));
    const actual = files.get(name) ?? "missing";
    const state = actual === expected ? "equal" : actual === "missing" ? "MISSING" : "DIFFERS";
    if (state !== "equal") mismatched += 1;

    out(`${state.padEnd(8)} ${name}`);
    out(`         repository ${expected}`);
    out(`         host       ${actual}`);
  }

  const cronState =
    cron === "" ? "not installed" : cron.split("\n").includes(CRON_LINE) ? "installed" : "differs";
  out("");
  out(`cron     ${cronState} (${CRON_FILE})`);
  if (cronState !== "installed") {
    out("         Not added by install. Since D103 the schedule is in the app; this line");
    out("         would start a second, unencrypted nightly dump. Decide before adding it.");
  }

  const failed = mismatched > 0 || (requireCron && cronState !== "installed");
  process.exitCode = failed ? 1 : 0;
  return { mismatched, cronState };
}

export async function install() {
  const archive = tar(
    HOST_FILES.map((file) => ({
      name: path.posix.basename(file),
      data: committed(file),
      mode: 0o755,
    })),
  );

  const { id } = await onHost(`mkdir -p /hs/vikt/infra`, ["/srv:/hs"], { keepAlive: true });
  try {
    // The helper's `mkdir` races this request, and Docker answers 404 for a
    // target directory that does not exist yet. Retried briefly rather than
    // shipping directory entries in the tar, which would reset the mode of a
    // `/srv/vikt` somebody had already set up.
    let put;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      put = await docker(`/containers/${id}/archive?path=${encodeURIComponent("/hs/vikt/infra")}`, {
        method: "PUT",
        headers: { "Content-Type": "application/x-tar" },
        body: archive,
      });
      if (put.status !== 404) break;
      await sleep(250);
    }
    if (!put.ok) throw new Error(`copying into the host failed: HTTP ${put.status}`);
    out(`installed ${HOST_FILES.length} files from HEAD ${commitShort()} into ${HOST_DIR}`);
    out("");
  } finally {
    await docker(`/containers/${id}?force=1`, { method: "DELETE" });
  }

  return check();
}

/* ------------------------------------------------------------------ cli -- */

const [command, ...flags] = process.argv.slice(2);

try {
  if (command === "check") await check({ requireCron: flags.includes("--require-cron") });
  else if (command === "install") await install();
  else {
    err("usage: host-scripts.mjs check [--require-cron] | install\n");
    process.exitCode = 2;
  }
} catch (error) {
  err(`host-scripts: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
