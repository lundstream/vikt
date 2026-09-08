import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { testEnv } from "./harness.js";
import { prepareTestDatabase } from "./database.js";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";

/**
 * Regression for the wiring, not the logic — the arithmetic of who to trust is
 * covered in `trust-proxy.test.ts`.
 *
 * `clientIp` was first assigned in an `onRequest` hook. Fastify writes its
 * "incoming request" line *before* hooks run, so the serialiser always read the
 * pre-hook value and every log line showed the proxy's address rather than the
 * client's. Nothing failed; the logs just quietly lied. Hence a test that reads
 * the log output itself.
 */

function captureLogs() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          // pino can flush partial lines; ignore anything unparseable.
        }
      }
      callback();
    },
  });
  return { lines, stream };
}

async function withApp(
  trustProxy: string,
  run: (app: Awaited<ReturnType<typeof buildApp>>, lines: Record<string, unknown>[]) => Promise<void>,
) {
  const url = await prepareTestDatabase();
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client, { schema }) as Db;
  const { lines, stream } = captureLogs();

  const app = await buildApp(testEnv({ TRUST_PROXY: trustProxy, LOG_LEVEL: "info" }), {
    db,
    logStream: stream,
  });
  await app.ready();
  try {
    await run(app, lines);
  } finally {
    await app.close();
    await client.end();
  }
}

/** The `ip` the request logger recorded for the most recent request. */
function loggedIp(lines: Record<string, unknown>[]): string | undefined {
  const entry = [...lines]
    .reverse()
    .find((line) => (line.req as { ip?: string } | undefined)?.ip !== undefined);
  return (entry?.req as { ip?: string } | undefined)?.ip;
}

describe("the logged client IP", () => {
  it("is the CF-Connecting-IP when the peer is trusted", async () => {
    // inject's default remote address is 127.0.0.1, so trust loopback here.
    await withApp("127.0.0.1/32", async (app, lines) => {
      await app.inject({
        method: "GET",
        url: "/api/health",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
      expect(loggedIp(lines)).toBe("203.0.113.9");
    });
  });

  it("ignores CF-Connecting-IP when the peer is not trusted", async () => {
    await withApp("172.31.240.0/24", async (app, lines) => {
      await app.inject({
        method: "GET",
        url: "/api/health",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
      expect(loggedIp(lines)).not.toBe("203.0.113.9");
    });
  });

  it("ignores it entirely when TRUST_PROXY is empty", async () => {
    await withApp("", async (app, lines) => {
      await app.inject({
        method: "GET",
        url: "/api/health",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
      expect(loggedIp(lines)).not.toBe("203.0.113.9");
    });
  });

  it("records the peer alongside it, so a wrong TRUST_PROXY is visible", async () => {
    await withApp("127.0.0.1/32", async (app, lines) => {
      await app.inject({
        method: "GET",
        url: "/api/health",
        headers: { "cf-connecting-ip": "203.0.113.9" },
      });
      const entry = [...lines].reverse().find((line) => line.req);
      expect((entry?.req as { peer?: string }).peer).toBeDefined();
    });
  });
});
