import { describe, expect, it } from "vitest";
import { createCipheriv } from "node:crypto";
import { connectSmb, NTLM_UNAVAILABLE } from "../src/lib/backup-smb.js";

/**
 * The SMB client and the runtime it has to live in (D132).
 *
 * This is the test that was missing, and its absence cost an outage. Eleven
 * tests covered the share destination and every one of them stopped at the TCP
 * layer: a refused connection to 127.0.0.1, which never reaches authentication.
 * The first time anybody pressed "test connection" against a **real** server the
 * connection succeeded, NTLM began, and the library called
 * `createCipheriv("des-ecb", ...)` — which OpenSSL 3 refuses.
 *
 * It threw from inside a socket callback, outside any promise chain, so the
 * `try/catch` around `connectSmb` could not catch it and the API process died.
 * An admin button took the server down.
 *
 * Two things are pinned here. **The runtime cannot do DES**, so nobody
 * rediscovers this by deploying. And **`connectSmb` rejects rather than
 * throwing asynchronously**, so a caller's `catch` is enough.
 */

describe("this runtime's crypto", () => {
  /**
   * Node 22 ships OpenSSL 3, which moved DES to the legacy provider. Every
   * environment this project runs in is Node 22: the workstation, CI, and the
   * API image. If this ever passes as available, the guard can go.
   */
  it("has no DES, which is what NTLM's LM hash needs", () => {
    expect(() => createCipheriv("des-ecb", Buffer.alloc(8), null)).toThrow();
  });
});

describe("connecting to a share", () => {
  const target = {
    host: "nas.invalid",
    share: "backup",
    domain: "",
    username: "someone",
    password: "secret",
    folder: "",
  };

  /**
   * A rejected promise, not a thrown-into-the-void error. This is the property
   * that keeps the process alive, and it is asserted with `rejects` precisely
   * because the failure mode it guards against would not be catchable here at
   * all — it would take the test runner down with it.
   */
  it("rejects instead of killing the process", async () => {
    await expect(connectSmb(target)).rejects.toThrow();
  });

  /** And says what to do instead, rather than naming an OpenSSL error code. */
  it("explains the way round it", async () => {
    await expect(connectSmb(target)).rejects.toThrow(/Mount the share on the host/);
    expect(NTLM_UNAVAILABLE).toContain("directory destination");
  });

  /** It refuses before it opens a socket, so an unreachable host is not the reason. */
  it("refuses without waiting for a network timeout", async () => {
    const started = Date.now();
    await expect(connectSmb(target)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
