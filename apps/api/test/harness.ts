import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/db/index.js";
import * as schema from "../src/db/schema.js";
import { prepareTestDatabase } from "./database.js";

/**
 * Per-test transactional rollback.
 *
 * Each test runs inside a transaction that is never committed, so tests cannot
 * see each other's rows and the database is identical before and after the
 * whole run. That is cheaper than truncating between tests and, more usefully,
 * it means a failing test leaves the database untouched for the next one
 * instead of half-populated.
 *
 * The app is built with that transaction as its `db` handle. `Db` is the
 * `PgDatabase` supertype precisely so a transaction satisfies it — the same
 * property that lets `register()` run inside one in production.
 *
 * Consequence worth knowing: services that open their own transaction get a
 * savepoint rather than a top-level one. That is what Drizzle does with a
 * nested `transaction()`, and it behaves the same for our purposes.
 */

const ROLLBACK = Symbol("rollback");

export type TestContext = {
  /** Call `app.inject(...)` on this. Never listens on a port. */
  app: FastifyInstance;
  /** The open transaction, for arranging rows directly. */
  db: Db;
};

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused-in-tests",
    SESSION_SECRET: "t".repeat(64),
    HOST: "127.0.0.1",
    PORT: 0,
    TRUST_PROXY: "",
    // Mail off by default in tests: the default must be the degraded path, so
    // a test that forgets to configure it exercises what a self-hosted install
    // without SMTP actually does (D88).
    // Modes off by default in tests, so a test that forgets to turn one on
    // exercises the degraded path a fresh self-hosted install actually has.
    LANDING_ENABLED: false,
    // The drainer is not started in tests: a background timer writing to a
    // rolled-back transaction is a race with no upside (D104).
    MAIL_WORKER_IN_PROCESS: false,
    LLM_ENABLED: true,
    SMTP_HOST: "",
    SMTP_PORT: 587,
    SMTP_USER: "",
    SMTP_PASS: "",
    SMTP_FROM: "Vikt <noreply@example.test>",
    SMTP_SECURE: false,
    // Absolute, because every link in every mail is built from it (D109) and a
    // relative one is what shipped an unusable invite code.
    PUBLIC_BASE_URL: "https://vikt.example.test",
    PUBLIC_ORIGIN: "",
    APP_NAME: "Vikt",
    SYSTEM_INTAKE_FLOOR_KCAL: 1200,
    COOKIE_SECURE: false,
    SESSION_TTL_DAYS: 30,
    CORS_ORIGINS: "",
    /**
     * Off in tests, which is the default configuration and the one that has to
     * keep working: §6 phase 8 says nothing may depend on this layer. A test
     * that needs the LLM stubs the client rather than pointing at a real host.
     */
    OLLAMA_URL: "",
    OLLAMA_MODEL_SMALL: "gemma4:e4b",
    OLLAMA_MODEL_LARGE: "qwen3.6:27b",
    OLLAMA_TIMEOUT_MS: 20000,
    OLLAMA_JOB_TIMEOUT_MS: 180000,
    LOG_LEVEL: "silent" as Env["LOG_LEVEL"],
    corsOrigins: [],
    ...overrides,
  };
}

/**
 * Wires the whole thing up for a test file. Returns a getter rather than the
 * context itself, because the transaction is opened per test and the value
 * changes between them.
 */
export function useTestApp(
  envOverrides: Partial<Env> = {},
  /** Extra build options — notably fixture food adapters instead of the network. */
  appOptions: Omit<BuildAppOptions, "db"> = {},
): () => TestContext {
  let client: postgres.Sql;
  let rootDb: Db;

  let context: TestContext | undefined;
  let finishTransaction: (() => void) | undefined;
  let transactionSettled: Promise<unknown> | undefined;

  beforeAll(async () => {
    const url = await prepareTestDatabase();
    // One connection: the tests are serialised, and a pool would hand different
    // statements to different sessions, which defeats the whole arrangement.
    client = postgres(url, { max: 1, onnotice: () => {} });
    rootDb = drizzle(client, { schema });
  }, 60_000);

  beforeEach(async () => {
    let handOverTx: (tx: Db) => void;
    const txReady = new Promise<Db>((resolve) => {
      handOverTx = resolve;
    });

    const holdOpen = new Promise<void>((resolve) => {
      finishTransaction = resolve;
    });

    // Start the transaction and keep its callback parked until the test is
    // done, then throw so Postgres rolls the whole thing back.
    transactionSettled = rootDb
      .transaction(async (tx) => {
        handOverTx(tx as Db);
        await holdOpen;
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });

    const db = await txReady;
    const app = await buildApp(testEnv(envOverrides), { ...appOptions, db });
    await app.ready();
    context = { app, db };
  });

  afterEach(async () => {
    await context?.app.close();
    finishTransaction?.();
    await transactionSettled;
    context = undefined;
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  return () => {
    if (!context) throw new Error("useTestApp() read outside a test");
    return context;
  };
}

/** Pulls the session cookie out of a `set-cookie` header for the next request. */
export function sessionCookieFrom(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") throw new Error("no set-cookie on that response");
  const value = header.split(";")[0];
  if (!value) throw new Error(`could not parse set-cookie: ${header}`);
  return value;
}
