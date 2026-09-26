import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { NormaliseResult } from "shared";
import type { ChatMessage, ChatOptions, ChatResult, LlmClient } from "../src/llm/client.js";
import type { Db } from "../src/db/index.js";
import { foodItems } from "../src/db/schema.js";
import type { FoodAdapter } from "../src/food/adapter.js";
import { LABEL_SCHEMA, readLabel } from "../src/llm/read-label.js";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * The label photo (Phase 14, D190): the one place the model returns figures,
 * and the three guards that keep it a transcription.
 */

/** What qwen3-vl:8b read off the quark cup, three runs of three, verbatim. */
const QUARK = {
  name: null,
  column: "per 100 g",
  basis: "100g",
  columns: 1,
  energyKj: 248,
  energyKcal: 59,
  fat: 0.2,
  saturatedFat: 0.1,
  carbohydrate: 4.4,
  sugars: 3.8,
  polyols: null,
  fibre: null,
  protein: 8.8,
  salt: 0.13,
  alcohol: null,
  servingSize: null,
};

/** The sugar-free sweets as printed: polyols inside 11 g of carbohydrate, 56 g of fibre. */
const SWEETS = {
  name: "Sockerfria lakritsbitar",
  basis: "100g" as const,
  energyKj: null,
  energyKcal: 164,
  fat: 0,
  saturatedFat: 0,
  carbohydrate: 11,
  sugars: 1.6,
  polyols: 8.3,
  fibre: 56,
  protein: 4.1,
  salt: 0.07,
  alcohol: null,
  servingSize: null,
  barcode: null as string | null,
};

function markedImage(): { image: string; marker: string } {
  const marker = `VIKT-LABEL-${randomUUID()}`;
  return { image: Buffer.from(`${marker}${"x".repeat(64)}`).toString("base64"), marker };
}

function stubLlm(content: string, calls: ChatOptions[] = []): LlmClient {
  const reply: ChatResult = { ok: true, content, model: "qwen3-vl:8b", ms: 1_400 };
  return {
    enabled: true,
    chat: async (options) => {
      calls.push(options);
      return reply;
    },
    chatStream: async () => reply,
    reachable: async () => true,
  };
}

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

describe("reading a label", () => {
  const calls: ChatOptions[] = [];
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(line);
      callback();
    },
  });
  const ctx = useTestApp(
    { LLM_VISION_MODEL: "qwen3-vl:8b", LOG_LEVEL: "info" },
    { llm: stubLlm(JSON.stringify(QUARK), calls), logStream: stream },
  );

  it("returns the transcription, and keeps the image nowhere", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const { image, marker } = markedImage();

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/read-label",
      headers: auth(user),
      payload: { image },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, label: { energyKcal: 59, fibre: null, columns: 1 } });
    expect(await anywhereInTheDatabase(db, marker)).toEqual([]);
    expect(lines.filter((line) => line.includes(marker) || line.includes(image))).toEqual([]);
    expect(lines.some((line) => line.includes("label read"))).toBe(true);
  });

  it("asks for the shape with a schema and shows the model no example figures", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await app.inject({
      method: "POST",
      url: "/api/llm/read-label",
      headers: auth(user),
      payload: { image: markedImage().image },
    });
    const call = calls.at(-1)!;
    expect(call.schema).toBe(LABEL_SCHEMA);
    const system = (call.messages[0] as ChatMessage).content;
    // No number in the prompt that could be transcribed as a label's figure.
    expect(system.match(/\d+[.,]\d+|\b\d{2,}\b/g) ?? []).toEqual(["100", "100", "100", "100", "5,6", "5.6", "56", "56"]);
  });
});

describe("readLabel", () => {
  it("reads a figure written with a decimal comma as the number it spells", () => {
    const outcome = readLabel(JSON.stringify({ ...QUARK, fat: "0,2" }));
    expect(outcome).toMatchObject({ ok: true, label: { fat: 0.2 } });
  });

  it("drops a serving size it cannot use rather than failing the figures", () => {
    const outcome = readLabel(JSON.stringify({ ...QUARK, servingSize: { amount: 2, unit: "st" } }));
    expect(outcome).toMatchObject({ ok: true, label: { servingSize: null } });
  });

  it("refuses output that is not the shape", () => {
    expect(readLabel("not json").ok).toBe(false);
    expect(readLabel(JSON.stringify({ ...QUARK, fat: "mycket" })).ok).toBe(false);
    expect(readLabel(JSON.stringify({ ...QUARK, kcalEstimate: 60 })).ok).toBe(false);
  });
});

/* ----------------------------------------------------------- the save */

let adapterLookups = 0;
const nothingAdapter: FoodAdapter = {
  source: "openfoodfacts",
  supportsBarcode: true,
  lookupBarcode: async (): Promise<NormaliseResult | null> => {
    adapterLookups += 1;
    return null;
  },
  search: async () => [],
};

describe("saving a transcribed label (D190)", () => {
  const ctx = useTestApp({}, { foodAdapters: [nothingAdapter] });

  const save = (app: Awaited<ReturnType<typeof ctx>>["app"], user: { cookie: string }, body: object) =>
    app.inject({ method: "POST", url: "/api/food/label", headers: { cookie: user.cookie }, payload: body });

  it("saves 56 g of fibre, which adds up, as an ordinary food of the person's own", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const response = await save(app, user, SWEETS);

    expect(response.statusCode).toBe(201);
    const item = response.json();
    expect(item).toMatchObject({
      source: "label_photo",
      visibility: "private",
      isEstimate: false,
      kcalPer100: 164,
      fiberPer100: 56,
      carbsPer100: 11,
    });
    const [row] = await db.select().from(foodItems).where(eq(foodItems.id, item.id));
    expect(row!.createdBy).toBe(user.userId);
  });

  it("refuses 5,6 g of fibre where the energy says 56, and saves nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const before = await db.select().from(foodItems).where(eq(foodItems.createdBy, user.userId));
    const response = await save(app, user, { ...SWEETS, fibre: 5.6 });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: "label_inconsistent",
      message: "Siffrorna stämmer inte inbördes, kontrollera mot förpackningen.",
    });
    const after = await db.select().from(foodItems).where(eq(foodItems.createdBy, user.userId));
    expect(after).toHaveLength(before.length);
  });

  it("refuses 56 g read where a label prints 5,6", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const crisp = {
      ...SWEETS,
      name: "Rostade kikärtor",
      energyKj: 1636,
      energyKcal: 388,
      fat: 9.4,
      carbohydrate: 49.4,
      polyols: null,
      protein: 22,
    };
    expect((await save(app, user, { ...crisp, fibre: 5.6 })).statusCode).toBe(201);
    expect((await save(app, user, { ...crisp, fibre: 56 })).statusCode).toBe(422);
  });

  it("attaches the barcode, so the next scan finds it without asking the databases", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const code = "7310000123459";

    adapterLookups = 0;
    const miss = await app.inject({ method: "GET", url: `/api/food/barcode/${code}`, headers: auth(user) });
    expect(miss.json().item).toBeNull();
    expect(adapterLookups).toBe(1);

    const saved = (await save(app, user, { ...SWEETS, barcode: code })).json();

    const hit = await app.inject({ method: "GET", url: `/api/food/barcode/${code}`, headers: auth(user) });
    expect(hit.json().item).toMatchObject({ id: saved.id, source: "label_photo" });
    expect(adapterLookups).toBe(1);
  });

  it("keeps it the person's own: another account's scan of the code does not find it", async () => {
    const { app, db } = ctx();
    const owner = await createUser(app, db);
    const stranger = await createUser(app, db);
    const code = "7310000123466";
    await save(app, owner, { ...SWEETS, barcode: code });

    const theirs = await app.inject({ method: "GET", url: `/api/food/barcode/${code}`, headers: auth(stranger) });
    expect(theirs.json().item).toBeNull();
  });

  it("keeps a printed serving as the food's portion", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = (await save(app, user, { ...SWEETS, servingSize: { amount: 25, unit: "g" } })).json();
    expect(item.servingHints).toEqual({ portion: 25 });
  });
});
