/**
 * The host-side scripts reach Postgres without a compose file (D163).
 *
 * On a Portainer-managed host there is no compose file `docker compose` can
 * read, so `backup.sh` and `restore-check.sh` fall back to `docker exec` by
 * container name. This runs both, from a directory with no compose file, with a
 * stand-in `docker` on PATH that records how it was called and answers like
 * Postgres would, and asserts every call went to the container by name.
 *
 * The scripts are read from the committed blob, not the working tree, for the
 * same reason `host-scripts.mjs` installs from it: on Windows the working copy
 * can be CRLF, and `sh` would fail on it before the thing under test ran.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../../..");

function hasSh(): boolean {
  return spawnSync("sh", ["-c", "exit 0"]).status === 0;
}

function committed(file: string): string {
  return execFileSync("git", ["show", `HEAD:${file}`], { cwd: REPO, encoding: "utf8" });
}

/**
 * A `docker` that logs its argv and plays Postgres: `pg_dump` writes bytes,
 * `psql` prints a row, everything else succeeds quietly. One call is one log
 * line, with the SQL's own newlines folded, or a multi-line query would read
 * as several calls.
 */
const FAKE_DOCKER = `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "$DOCKER_LOG"
echo >> "$DOCKER_LOG"
case "$*" in
  *pg_dump*) printf 'PGDMP-fake' ;;
  *psql*) echo "users 1" ;;
esac
exit 0
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(script: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "vikt-host-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  const infra = path.join(dir, "infra");
  execFileSync("sh", ["-c", `mkdir -p "$1" "$2"`, "sh", bin, infra]);

  writeFileSync(path.join(bin, "docker"), FAKE_DOCKER);
  chmodSync(path.join(bin, "docker"), 0o755);
  writeFileSync(path.join(infra, script), committed(`infra/${script}`));
  chmodSync(path.join(infra, script), 0o755);

  const log = path.join(dir, "docker.log");
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    DOCKER_LOG: log,
    // Anything a developer's shell might have that would change the branch.
    COMPOSE: "false",
  };
  return { dir, infra, log, env };
}

describe.skipIf(!hasSh())("host-side scripts without a compose file", () => {
  it("backup.sh dumps through docker exec on vikt-postgres-1", () => {
    const { dir, infra, log, env } = setup("backup.sh");
    const backups = path.join(dir, "backups");

    const result = spawnSync("sh", [path.join(infra, "backup.sh")], {
      env: { ...env, BACKUP_DIR: backups, UPLOADS_DIR: path.join(dir, "no-uploads") },
      encoding: "utf8",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toBe("exec -i vikt-postgres-1 pg_dump -U vikt -d vikt -Fc");
    expect(calls.every((call) => !call.startsWith("compose"))).toBe(true);

    const dumps = execFileSync("sh", ["-c", `ls "$1"`, "sh", backups], { encoding: "utf8" });
    expect(dumps).toMatch(/^vikt-\d{8}T\d{6}Z\.dump$/m);
    expect(dumps).not.toMatch(/\.partial/);
  });

  it("restore-check.sh restores and compares through the named container", () => {
    const { dir, infra, log, env } = setup("restore-check.sh");
    const dump = path.join(dir, "some.dump");
    writeFileSync(dump, "PGDMP-fake");

    const result = spawnSync("sh", [path.join(infra, "restore-check.sh"), dump], {
      env: { ...env, POSTGRES_CONTAINER: "elsewhere-db" },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThan(4);
    expect(calls.every((call) => call.startsWith("exec -i elsewhere-db "))).toBe(true);
    expect(calls.some((call) => call.includes("pg_restore"))).toBe(true);
    expect(calls.at(-1)).toMatch(/drop database if exists/);
  });
});
