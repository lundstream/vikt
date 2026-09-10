import { promisify } from "node:util";
import type { Writable } from "node:stream";
import SMB2 from "@marsaud/smb2";

/**
 * Writing a backup to a Windows share, over the protocol (D130).
 *
 * ## Why not a mount
 *
 * The obvious way to reach a share from a container is `mount -t cifs`, and it
 * is the wrong way here: mounting inside a container requires `CAP_SYS_ADMIN`,
 * which is most of the way to root on the host. Granting it so that a backup
 * can be written is a bad trade, and it is a trade a self-hoster following the
 * README would make without knowing they had made it.
 *
 * Speaking SMB from Node needs no capability, no privileged container and no
 * host-side fstab entry. It also puts the host, share, username and password in
 * the admin screen next to everything else that is configured there, under the
 * same encrypted-secret pattern as the SMTP password, instead of in a compose
 * file the app cannot see.
 *
 * **The mounted path is still supported and is still the fallback**: point the
 * `local` destination at a path that happens to be a mount the host set up, and
 * nothing here is involved. That is the answer for a share this client cannot
 * talk to, and the README says so.
 *
 * ## What this client can and cannot do
 *
 * `@marsaud/smb2` speaks **SMB 2.0.2**. Samba and every Windows since Vista
 * accept it; a server hardened to require SMB 3 will refuse the connection, and
 * so will one that insists on encryption or signing beyond what 2.0.2 offers.
 * That failure is a clean refusal at connect time rather than a corrupt
 * backup, the "test connection" button surfaces it in one press, and the
 * mounted path above is the way through it.
 *
 * The dump is encrypted **before** it reaches this file, by the same code that
 * encrypts a local one. Nothing readable crosses the network, which is what
 * makes an SMB 2.0.2 transport acceptable for this and would not make it
 * acceptable for a password.
 */

export type SmbTarget = {
  host: string;
  share: string;
  domain: string;
  username: string;
  password: string;
  /** A folder inside the share. Empty means the root of it. */
  folder: string;
};

/**
 * A connected share, with the handful of operations a backup needs.
 *
 * `close` is not optional. The library holds an open socket and a timer, and a
 * process that forgets to disconnect keeps both until the timer fires; in a
 * long-lived API that is a leak per backup.
 */
export type SmbSession = {
  createWriteStream: (name: string) => Promise<Writable>;
  unlink: (name: string) => Promise<void>;
  list: () => Promise<string[]>;
  mtimeOf: (name: string) => Promise<Date | null>;
  close: () => void;
};

/**
 * SMB paths use backslashes, and the folder may be empty.
 *
 * Joined here rather than at each call site, because "the folder is empty"
 * turning into a leading backslash is exactly the kind of thing that produces
 * a file in the root of the share when somebody asked for one in a folder.
 */
function joinSmb(folder: string, name: string): string {
  const clean = folder.replace(/^[\\/]+|[\\/]+$/g, "").replace(/\//g, "\\");
  return clean === "" ? name : `${clean}\\${name}`;
}

export async function connectSmb(target: SmbTarget): Promise<SmbSession> {
  const host = target.host.trim().replace(/^\\+/, "");
  const share = target.share.trim().replace(/^[\\/]+|[\\/]+$/g, "");

  if (host === "" || share === "") {
    throw new Error("An SMB destination needs both a host and a share name.");
  }

  const client = new SMB2({
    share: `\\\\${host}\\${share}`,
    domain: target.domain.trim(),
    username: target.username,
    password: target.password,
    /**
     * A dump can take longer than the library's five-second idle default, and
     * the socket closing underneath a stream that is still being written is a
     * truncated backup that looks like a finished one.
     */
    autoCloseTimeout: 0,
  });

  const folder = target.folder.trim();
  if (folder !== "") {
    // `mkdir` on something that is already there is an error, not a no-op, and
    // "the folder exists" is the normal case rather than a problem.
    await promisify(client.mkdir).call(client, folder.replace(/\//g, "\\")).catch(() => {});
  }

  return {
    createWriteStream: (name) =>
      promisify(client.createWriteStream).call(client, joinSmb(folder, name)),
    unlink: (name) => promisify(client.unlink).call(client, joinSmb(folder, name)),
    list: async () => {
      const entries = await promisify(client.readdir)
        .call(client, folder === "" ? "" : folder.replace(/\//g, "\\"))
        .catch(() => [] as string[]);
      return entries;
    },
    mtimeOf: async (name) => {
      const info = await promisify(client.stat)
        .call(client, joinSmb(folder, name))
        .catch(() => null);
      return info?.mtime ?? null;
    },
    close: () => client.disconnect(),
  };
}

/**
 * What to show an operator when a connection fails.
 *
 * The library's own messages are mostly a status code and a constant name, and
 * `STATUS_LOGON_FAILURE` in a red box on an admin screen is a puzzle rather
 * than an answer. These three are the ones that actually happen, and each one
 * has a different fix.
 */
export function explainSmbError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (/LOGON_FAILURE|ACCESS_DENIED|STATUS_ACCOUNT/i.test(raw)) {
    return `The server refused the username or password (${raw}).`;
  }
  if (/BAD_NETWORK_NAME|OBJECT_PATH_NOT_FOUND|OBJECT_NAME_NOT_FOUND/i.test(raw)) {
    return `The server has no such share or folder (${raw}).`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|NEGOTIATE|DIALECT/i.test(raw)) {
    return (
      `Could not reach the server, or it would not agree a protocol version (${raw}). ` +
      "This client speaks SMB 2.0.2; a server that requires SMB 3 will refuse it, and a " +
      "mounted path on the host is the way round that."
    );
  }
  return raw;
}
