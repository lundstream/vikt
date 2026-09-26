import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import {
  deleteObject,
  getObjectBytes,
  listNames,
  objectKey,
  putObject,
  s3ClientFor,
  type S3Target,
} from "./backup-s3.js";

/**
 * Where stored images live (Phase 14, D191): the app's first.
 *
 * One interface, two backends. A **directory**, bound into the container from
 * the host (`MEDIA_HOST_DIR` at `/media`, the way the backup directory is),
 * and **S3**, using the connection the backup already has, under its own
 * folder. Everything above this file speaks keys and bytes and cannot tell
 * which one it has.
 *
 * **A key is a fixed shape, and nothing else is accepted**:
 * `users/<user id>/meals/<meal id>-<random>.jpg`. The user's id is the first
 * folder, so removing an account is removing one prefix, and a key built from
 * anything a request supplied cannot climb out of it, because a key that does
 * not match is refused before it becomes a path.
 */
export type MediaStore = {
  kind: "directory" | "s3";
  put(key: string, body: Buffer): Promise<void>;
  /** The bytes, or null when there is no such object. */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Every key under a user's folder, or under all of them for `users/`. */
  list(prefix: string): Promise<string[]>;
  /** Removes a user's folder and everything in it. Returns how many went. */
  deletePrefix(prefix: string): Promise<number>;
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(`^users/${UUID}/meals/${UUID}-[0-9a-f]{8}\\.jpg$`);
const PREFIX = new RegExp(`^users/(?:${UUID}/)?$`);

export class MediaUnavailable extends Error {}

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new Error(`not a media key: ${key.slice(0, 80)}`);
}

function assertPrefix(prefix: string): void {
  if (!PREFIX.test(prefix)) throw new Error(`not a media prefix: ${prefix.slice(0, 80)}`);
}

/** A new key for a meal's photo. Random, so a replaced photo is a new URL. */
export function mealPhotoKey(userId: string, mealId: string): string {
  return `users/${userId}/meals/${mealId}-${randomBytes(4).toString("hex")}.jpg`;
}

/** A user's folder, for removing everything they stored. */
export function userMediaPrefix(userId: string): string {
  return `users/${userId}/`;
}

/**
 * Where the directory backend keeps its files.
 *
 * `MEDIA_DIR` when set. Unset, production uses `/media`, the path the stack
 * binds `MEDIA_HOST_DIR` to, and a workstation uses `.media` beside the API,
 * so development needs no configuration and writes nowhere surprising.
 */
export function mediaRoot(env: Pick<Env, "MEDIA_DIR" | "NODE_ENV">): string {
  if (env.MEDIA_DIR.trim() !== "") return path.resolve(env.MEDIA_DIR.trim());
  return env.NODE_ENV === "production" ? "/media" : path.resolve(".media");
}

export function directoryStore(root: string): MediaStore {
  const base = path.resolve(root);
  const full = (key: string) => {
    const target = path.resolve(base, ...key.split("/"));
    // The key's shape already rules this out; the check is the second lock.
    if (!target.startsWith(base + path.sep)) throw new Error("media key left the media folder");
    return target;
  };

  async function walk(dir: string, relative: string, found: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), next, found);
      else if (KEY.test(next)) found.push(next);
    }
  }

  return {
    kind: "directory",
    async put(key, body) {
      assertKey(key);
      const target = full(key);
      await mkdir(path.dirname(target), { recursive: true });
      // Written beside and renamed over, so a reader never sees half a photo.
      const temporary = `${target}.${randomBytes(4).toString("hex")}.part`;
      await writeFile(temporary, body);
      await rename(temporary, target);
    },
    async get(key) {
      assertKey(key);
      return readFile(full(key)).catch(() => null);
    },
    async delete(key) {
      assertKey(key);
      await rm(full(key), { force: true });
    },
    async list(prefix) {
      assertPrefix(prefix);
      const found: string[] = [];
      const relative = prefix.replace(/\/$/, "");
      const start = path.resolve(base, ...relative.split("/"));
      await walk(start, relative, found);
      return found.sort();
    },
    async deletePrefix(prefix) {
      assertPrefix(prefix);
      if (prefix === "users/") throw new Error("refusing to remove every user's media");
      const keys = await this.list(prefix);
      await rm(path.resolve(base, ...prefix.replace(/\/$/, "").split("/")), {
        recursive: true,
        force: true,
      });
      return keys.length;
    },
  };
}

/**
 * The S3 backend: the backup's own connection, in a `media` folder beside the
 * backups. Resolved on each call rather than at boot, so changing the backup
 * destination under Administration is picked up without a restart, and a
 * destination that is not S3 is a readable refusal rather than a crash.
 */
export function s3Store(resolveTarget: () => Promise<S3Target | null>): MediaStore {
  async function withClient<T>(work: (target: S3Target, client: ReturnType<typeof s3ClientFor>) => Promise<T>) {
    const backup = await resolveTarget();
    if (backup === null) {
      throw new MediaUnavailable(
        "Foton lagras i S3, men backupen är inte inställd på S3. Välj S3 under Administration, Backup.",
      );
    }
    const target = { ...backup, prefix: objectKey(backup.prefix, "media") };
    const client = s3ClientFor(target);
    try {
      return await work(target, client);
    } finally {
      client.destroy();
    }
  }

  return {
    kind: "s3",
    async put(key, body) {
      assertKey(key);
      await withClient((target, client) => putObject(client, target, key, body));
    },
    async get(key) {
      assertKey(key);
      return withClient((target, client) => getObjectBytes(client, target, key));
    },
    async delete(key) {
      assertKey(key);
      await withClient((target, client) => deleteObject(client, target, key));
    },
    async list(prefix) {
      assertPrefix(prefix);
      return withClient(async (target, client) =>
        (await listNames(client, target, prefix)).filter((key) => KEY.test(key)).sort(),
      );
    },
    async deletePrefix(prefix) {
      assertPrefix(prefix);
      if (prefix === "users/") throw new Error("refusing to remove every user's media");
      return withClient(async (target, client) => {
        const keys = (await listNames(client, target, prefix)).filter((key) => KEY.test(key));
        for (const key of keys) await deleteObject(client, target, key);
        return keys.length;
      });
    },
  };
}

/** The store `MEDIA_STORAGE` names. */
export function createMediaStore(
  env: Pick<Env, "MEDIA_DIR" | "MEDIA_STORAGE" | "NODE_ENV">,
  resolveS3: (db: Db) => Promise<S3Target | null>,
  db: () => Db,
): MediaStore {
  return env.MEDIA_STORAGE === "s3"
    ? s3Store(() => resolveS3(db()))
    : directoryStore(mediaRoot(env));
}
