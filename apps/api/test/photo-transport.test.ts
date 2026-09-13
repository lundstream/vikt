import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { ChatMessage, ChatResult, LlmClient } from "../src/llm/client.js";
import type { Db } from "../src/db/index.js";
import { PHOTO_MAX_BASE64 } from "shared";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * What happens to the photograph (D143).
 *
 * This file is the one that holds the promise the feature is sold on: **the
 * image is read and dropped.** Not written to disk, not written to any table,
 * not put in a log line, not queued. A photograph of a plate is a photograph of
 * somebody's kitchen and of whoever they were eating with, and a self-hosted app
 * asking for one has to be able to say where it went.
 *
 * "Asserted in a comment" is how the SMB client came to have tests that never
 * reached authentication, so the marker below is a random string carried inside
 * the base64 and then looked for in **every text column of every table** and in
 * **every line the logger emitted**. A future change that decides to keep the
 * image for debugging fails here rather than being noticed by somebody reading
 * a backup.
 */

/** A recognisable payload: if these bytes are kept anywhere, they are findable. */
function markedImage(): { image: string; marker: string } {
  const marker = `VIKT-PHOTO-${randomUUID()}`;
  // Padded so it is comfortably over the schema's floor for an image.
  return { image: Buffer.from(`${marker}${"x".repeat(64)}`).toString("base64"), marker };
}

function stubLlm(reply: ChatResult, seen: ChatMessage[][] = []): LlmClient {
  return {
    enabled: true,
    chat: async (options) => {
      seen.push(options.messages);
      return reply;
    },
    chatStream: async (_options, onDelta) => {
      if (reply.ok) onDelta(reply.content);
      return reply;
    },
    reachable: async () => true,
  };
}

const modelSays = (items: unknown): ChatResult => ({
  ok: true,
  content: JSON.stringify({ items }),
  model: "qwen3-vl:8b",
  ms: 14_200,
});

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(line);
      callback();
    },
  });
  return { lines, stream };
}

/**
 * Every text-ish column in the schema, asked whether it contains the marker.
 *
 * Column by column rather than by inspecting the tables this feature happens to
 * know about, because the interesting failure is a column it does not know
 * about: a debug table somebody adds, a JSON blob somewhere that quietly starts
 * carrying the request body.
 */
async function anywhereInTheDatabase(db: Db, needle: string): Promise<string[]> {
  const columns = (await db.execute(
    sql`select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and data_type in ('text', 'character varying', 'json', 'jsonb')`,
  )) as unknown as { table_name: string; column_name: string }[];

  const found: string[] = [];
  for (const column of columns) {
    const hits = (await db.execute(
      sql.raw(
        `select 1 from "${column.table_name}" where "${column.column_name}"::text like '%${needle}%' limit 1`,
      ),
    )) as unknown as unknown[];
    if (hits.length > 0) found.push(`${column.table_name}.${column.column_name}`);
  }
  return found;
}

describe("a photograph that parsed", () => {
  const seen: ChatMessage[][] = [];
  const { lines, stream } = captureLogs();
  const ctx = useTestApp(
    { LLM_VISION_MODEL: "qwen3-vl:8b", LOG_LEVEL: "info" },
    {
      llm: stubLlm(
        modelSays([{ name: "kebabpizza", amount: { count: 1, unit: "st" } }]),
        seen,
      ),
      logStream: stream,
    },
  );

  it("sends the image to the model and keeps it nowhere", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { image, marker } = markedImage();

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-photo",
      headers: auth(user),
      payload: { image, note: "kebabpizza, hela" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, model: "qwen3-vl:8b" });

    // It did reach the model, on the message, which is where Ollama takes it.
    const messages = seen.at(-1) ?? [];
    expect(messages.at(-1)?.images).toEqual([image]);
    // And the words beside it went into the same call, not a second one.
    expect(seen).toHaveLength(1);
    expect(messages.at(-1)?.content).toContain("kebabpizza, hela");

    // Nothing anywhere in the database holds the bytes, or the marker inside
    // them, or the line the user typed beside them.
    expect(await anywhereInTheDatabase(db, image.slice(0, 40))).toEqual([]);
    expect(await anywhereInTheDatabase(db, marker)).toEqual([]);
    expect(await anywhereInTheDatabase(db, "kebabpizza, hela")).toEqual([]);
  });

  /**
   * The logger is the other place bytes leak to, and the easier one to do by
   * accident: one `request.log.info({ body })` while debugging and every
   * photograph anybody ever sent is in the log file.
   */
  it("logs that a photo was parsed, and none of what was in it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { image, marker } = markedImage();

    lines.length = 0;

    await app.inject({
      method: "POST",
      url: "/api/llm/parse-photo",
      headers: auth(user),
      payload: { image, note: "kebabpizza, hela" },
    });

    const logged = lines.join("\n");
    expect(logged).not.toContain(image.slice(0, 40));
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain("kebabpizza");

    /**
     * And it does say something. A path that logs nothing at all would pass
     * every assertion above and leave the operator of a self-hosted box unable
     * to tell whether the feature is being used or how slow it is.
     */
    const line = lines.find((entry) => entry.includes("photo parsed"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({ model: "qwen3-vl:8b", items: 1, hadNote: true });
    expect(parsed.kb).toBeTypeOf("number");
  });
});

describe("the scan itself", () => {
  const ctx = useTestApp();

  /**
   * A search that finds nothing proves nothing until it has been shown finding
   * something. Two guards in this repo were green for months while reaching
   * neither the code nor the case they claimed to cover, so the marker is
   * planted in an ordinary row first and the scan is made to see it.
   */
  it("finds a marker that really is in the database", async () => {
    const { db } = ctx();
    const { marker } = markedImage();

    await db.execute(
      sql.raw(`insert into app_settings (key, value) values ('probe', '${marker}')`),
    );

    expect(await anywhereInTheDatabase(db, marker)).toContain("app_settings.value");
  });
});

describe("with no vision model named", () => {
  const seen: ChatMessage[][] = [];
  const ctx = useTestApp({}, { llm: stubLlm(modelSays([]), seen) });

  /**
   * Absent rather than broken, like every other optional mode. Told apart from
   * an unreachable box on purpose: one is an installation that was never
   * configured for this, the other is a workstation somebody switched off.
   */
  it("answers 200 with not_configured and never calls the model", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { image } = markedImage();

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-photo",
      headers: auth(user),
      payload: { image },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: "not_configured" });
    expect(seen).toHaveLength(0);
  });
});

describe("an image that was never resized", () => {
  const ctx = useTestApp(
    { LLM_VISION_MODEL: "qwen3-vl:8b" },
    { llm: stubLlm(modelSays([])) },
  );

  /**
   * The client resizes to 1280 px, which measured at 77 to 211 kB. Two
   * megabytes is therefore not a budget, it is the boundary that catches a
   * client which did not resize at all — and the server refuses it rather than
   * spending a minute of GPU on somebody's eleven megabyte original.
   */
  it("is refused by the schema, with a 400 rather than a timeout", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-photo",
      headers: auth(user),
      payload: { image: "A".repeat(PHOTO_MAX_BASE64 + 4) },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });

  /**
   * And a body too large to read at all is refused before it is read.
   *
   * Two limits rather than one, because they fail at different moments. The
   * schema's ceiling is checked after the body has been parsed, which means the
   * server has already held several megabytes in memory; the route's own
   * `bodyLimit` stops the socket. Fastify's default is one megabyte, which
   * would have refused every legitimate photograph, so this route raises it
   * deliberately and the test says what it was raised to.
   */
  it("refuses a body past the route's own limit with a 413", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-photo",
      headers: auth(user),
      payload: { image: "A".repeat(PHOTO_MAX_BASE64 + 8192) },
    });

    expect(response.statusCode).toBe(413);
  });
});

describe("a burst of photographs", () => {
  const ctx = useTestApp(
    { LLM_VISION_MODEL: "qwen3-vl:8b" },
    { llm: stubLlm(modelSays([])) },
  );

  /**
   * The coach's allowance, because both queue on the one GPU this installation
   * has. Separate buckets, so a day of logging meals cannot use up the
   * conversation.
   */
  it("stops at the coach's hourly allowance and says how long to wait", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { image } = markedImage();

    const send = () =>
      app.inject({
        method: "POST",
        url: "/api/llm/parse-photo",
        headers: auth(user),
        payload: { image },
      });

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await send()).json()).toMatchObject({ available: true });
    }

    const refused = (await send()).json<{ reason: string; retryAfterSeconds: number }>();
    expect(refused.reason).toBe("rate_limited");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });
});
