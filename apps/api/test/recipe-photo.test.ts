import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { ReadRecipeResponse } from "shared";
import type { ChatMessage, ChatOptions, ChatResult, LlmClient } from "../src/llm/client.js";
import type { Db } from "../src/db/index.js";
import { foodEntries, foodItems } from "../src/db/schema.js";
import { RECIPE_SCHEMA, readRecipe } from "../src/llm/read-recipe.js";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * A recipe photographed (D195): the model copies lines, the shared reader
 * splits them, the database prices them, and nothing is kept.
 *
 * The replies are what `qwen3-vl:8b` returned in the final probe, verbatim,
 * ingredient rows only. Its misreadings are kept, because those are what the
 * reader is given in practice.
 */

const BOOK = {
  title: "PECORINO & PAN CETTA",
  yield: "1 PIZZA",
  rows: [
    "1 pizzaboll, se sidan 110",
    "0,39 g (50 g) mozzarella di bufala DOP, i bitar",
    "20 g (25 g) lardo alt pancetta eller bacon, finskuren",
    "3 g (3,5 g) vitlök, finskvad (ca 1 vitlöksklyfta)",
    "3-5 färsk basilikablad",
    "12 g (15 g) pecorino romano DOP, finriven",
    "3 g + 5 g (3 g + 7 g) olivolja",
  ].map((line) => ({ line, section: null })),
};

const SCREEN = {
  title: "Köttfärsås",
  yield: "4 portioner",
  rows: [
    ["Köttfärsås", "1 msk olja"],
    ["Köttfärsås", "1 förp krossade tomater (å 390 g)"],
    ["Köttfärsås", "salt"],
    ["Ostsås", "6 msk smör (6 msk motsvarar ca 90 g)"],
    ["Ostsås", "10 dl mjölk"],
  ].map(([section, line]) => ({ line, section })),
};

function markedImage(): { image: string; marker: string } {
  const marker = `VIKT-RECIPE-${randomUUID()}`;
  return { image: Buffer.from(`${marker}${"x".repeat(64)}`).toString("base64"), marker };
}

function stubLlm(reply: object, calls: ChatOptions[] = []): LlmClient {
  const result: ChatResult = { ok: true, content: JSON.stringify(reply), model: "qwen3-vl:8b", ms: 1_700 };
  return {
    enabled: true,
    chat: async (options) => {
      calls.push(options);
      return result;
    },
    chatStream: async () => result,
    reachable: async () => true,
  };
}

async function food(db: Db, name: string, category: string | null, kcalPer100: number): Promise<void> {
  await db.insert(foodItems).values({
    source: "manual",
    name,
    kcalPer100: String(kcalPer100),
    category,
    visibility: "shared",
  });
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

type Read = Extract<ReadRecipeResponse, { available: true }>;

describe("reading a cookbook page with two amount sets", () => {
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
    { llm: stubLlm(BOOK, calls), logStream: stream },
  );

  async function read(): Promise<{ body: Read; db: Db; marker: string }> {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await food(db, "Olivolja", "oil", 884);
    const { image, marker } = markedImage();
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/read-recipe",
      headers: auth(user),
      payload: { image },
    });
    expect(response.statusCode).toBe(200);
    return { body: response.json() as Read, db, marker };
  }

  it("returns every row with both sets, the model choosing neither", async () => {
    const { body } = await read();
    expect(body).toMatchObject({ available: true, twoSets: true, yield: { printed: "1 PIZZA", portions: null } });
    expect(body.rows).toHaveLength(7);
    expect(body.rows.map((row) => row.sets.map((set) => set.grams))).toEqual([
      [null, null],
      [0.39, 50],
      [20, 25],
      [3, 3.5],
      [null, null],
      [12, 15],
      [8, 10],
    ]);
    expect(body.rows.every((row) => row.line.length > 0)).toBe(true);
  });

  it("marks the mozzarella row, and only it, to check against the page", async () => {
    const { body } = await read();
    expect(body.rows.map((row) => row.check)).toEqual([false, true, false, false, false, false, false]);
  });

  it("prices a matched row from the database, for each set", async () => {
    const { body } = await read();
    const oil = body.rows[6]!;
    expect(oil.match).toMatchObject({ name: "Olivolja", kcalPer100: 884 });
    expect(oil.sets.map((set) => set.kcal)).toEqual([70.7, 88.4]);
    expect(oil.sets[0]).toMatchObject({ printed: "3 g + 5 g", source: "printed" });
  });

  it("leaves the cross-reference unmatched and unsearched, and the range empty", async () => {
    const { body } = await read();
    expect(body.rows[0]).toMatchObject({ reference: true, match: null });
    expect(body.rows[4]!.sets[0]).toMatchObject({ printed: "3-5", grams: null, reason: "range" });
    expect(body.rows[2]!.name).toBe("lardo");
  });

  it("keeps the image nowhere and logs counts, not lines", async () => {
    const { db, marker } = await read();
    expect(await anywhereInTheDatabase(db, marker)).toEqual([]);
    expect(lines.filter((line) => line.includes(marker))).toEqual([]);
    expect(lines.filter((line) => line.includes("mozzarella"))).toEqual([]);
    const logged = lines.find((line) => line.includes("recipe read"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ rows: 7, twoSets: true, checks: 1 });
  });

  it("asks for lines with a schema and shows the model no example at all", async () => {
    await read();
    const call = calls.at(-1)!;
    expect(call.schema).toBe(RECIPE_SCHEMA);
    const system = (call.messages[0] as ChatMessage).content;
    expect(system.match(/\d/g)).toBeNull();
  });
});

describe("reading a recipe off a screen, one set", () => {
  const ctx = useTestApp({ LLM_VISION_MODEL: "qwen3-vl:8b" }, { llm: stubLlm(SCREEN) });

  it("fills the portion count, converts what the app converts, and keeps printed weights", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await food(db, "Olja", "oil", 900);
    await food(db, "Mjölk", "dairy_liquid", 64);
    await food(db, "Krossade tomater", null, 24);
    await food(db, "Smör", "butter", 740);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/read-recipe",
      headers: auth(user),
      payload: { image: markedImage().image },
    });
    const body = response.json() as Read;

    expect(body).toMatchObject({ twoSets: false, yield: { printed: "4 portioner", portions: 4 } });
    expect(body.rows.map((row) => row.sets.length)).toEqual([1, 1, 1, 1, 1]);
    expect(body.rows.map((row) => row.section)).toEqual(["Köttfärsås", "Köttfärsås", "Köttfärsås", "Ostsås", "Ostsås"]);
    const [oil, tomatoes, salt, butter, milk] = body.rows.map((row) => row.sets[0]!);
    expect(oil).toMatchObject({ grams: 14, source: "converted" });
    expect(tomatoes).toMatchObject({ grams: 390, source: "printed" });
    expect(salt).toMatchObject({ grams: null, reason: "none" });
    expect(butter).toMatchObject({ grams: 90, source: "printed" });
    expect(milk).toMatchObject({ grams: 1000, source: "converted", kcal: 640 });
  });
});

/**
 * The matcher reads twenty candidates (D196). A stricter test needs the right
 * row among them. Search ranks short names first among equals, so eight
 * flavoured milks, each "Mjölk" and one word the matcher refuses, come ahead
 * of plain milk; at five candidates the answer was "no match".
 */
describe("the matcher reads far enough down the search", () => {
  const MILK = { title: null, yield: null, rows: [{ line: "10 dl mjölk", section: null }] };
  const ctx = useTestApp({ LLM_VISION_MODEL: "qwen3-vl:8b" }, { llm: stubLlm(MILK) });

  it("finds plain milk behind the flavoured ones", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    for (const flavour of ["kakao", "banan", "mango", "kaffe", "hallon", "vanilj", "choklad", "jordgubb"]) {
      await food(db, `Mjölk ${flavour}`, "dairy_liquid", 80);
    }
    await food(db, "Mjölk fett 3% berikad", "dairy_liquid", 60);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/read-recipe",
      headers: auth(user),
      payload: { image: markedImage().image },
    });
    const body = response.json() as Read;
    expect(body.rows[0]!.match).toMatchObject({ name: "Mjölk fett 3% berikad", kcalPer100: 60 });
  });
});

/**
 * Which of several accepted rows the matcher proposes (D198): the one this
 * person has logged most, then the search's order, which is now total, so the
 * same person asking the same thing always gets the same food.
 */
describe("the matcher chooses among the rows it accepts", () => {
  const CHEESE = { title: null, yield: null, rows: [{ line: "100 g ost", section: null }] };
  const MILK = { title: null, yield: null, rows: [{ line: "10 dl mjölk", section: null }] };
  const MINCE = { title: null, yield: null, rows: [{ line: "500 g nötfärs", section: null }] };

  async function row(db: Db, name: string, source: "livsmedelsverket" | "openfoodfacts", kcal: number) {
    const [item] = await db
      .insert(foodItems)
      .values({ source, name, kcalPer100: String(kcal), visibility: "shared" })
      .returning({ id: foodItems.id });
    return item!.id;
  }

  async function logged(db: Db, userId: string, foodItemId: string, times: number) {
    await db.insert(foodEntries).values(
      [...Array(times).keys()].map(() => ({
        userId,
        clientUuid: randomUUID(),
        localDate: localDate(),
        mealSlot: "lunch" as const,
        foodItemId,
        grams: "100.0",
        kcal: "100.0",
        confirmed: true,
      })),
    );
  }

  const read = async (app: ReturnType<ReturnType<typeof useTestApp>>["app"], user: TestUser) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/read-recipe",
      headers: auth(user),
      payload: { image: markedImage().image },
    });
    return (response.json() as Read).rows[0]!.match;
  };

  describe("with no history", () => {
    const ctx = useTestApp({ LLM_VISION_MODEL: "qwen3-vl:8b" }, { llm: stubLlm(CHEESE) });

    it("takes Livsmedelsverket's row among equals, and the same one every time", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);
      await row(db, "Ost", "openfoodfacts", 252);
      await row(db, "Ost", "livsmedelsverket", 354);
      await row(db, "Ost", "openfoodfacts", 351);
      const answers = [await read(app, user), await read(app, user), await read(app, user)];
      expect(answers.map((match) => match?.kcalPer100)).toEqual([354, 354, 354]);
    });
  });

  describe("with history", () => {
    const ctx = useTestApp({ LLM_VISION_MODEL: "qwen3-vl:8b" }, { llm: stubLlm(CHEESE) });

    it("takes the row this person has logged most", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);
      await row(db, "Ost", "livsmedelsverket", 354);
      const theirs = await row(db, "Ost", "openfoodfacts", 252);
      await logged(db, user.userId, theirs, 3);
      expect((await read(app, user))?.kcalPer100).toBe(252);

      // Another person, who has logged nothing, still gets the stable order.
      const other = await createUser(app, db);
      expect((await read(app, other))?.kcalPer100).toBe(354);
    });
  });

  describe("history and a refused row", () => {
    const ctx = useTestApp({ LLM_VISION_MODEL: "qwen3-vl:8b" }, { llm: stubLlm(MILK) });

    it("never makes a refused row plausible, however often it was logged", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);
      const chocolate = await row(db, "Mjölkchoklad", "livsmedelsverket", 535);
      await row(db, "Mjölk fett 3% berikad", "livsmedelsverket", 60);
      await logged(db, user.userId, chocolate, 10);
      expect((await read(app, user))?.name).toBe("Mjölk fett 3% berikad");
    });
  });

  /** "nötfärs" is not in the search's twenty when the catalogue writes it apart. */
  describe("a compound written apart", () => {
    const ctx = useTestApp({ LLM_VISION_MODEL: "qwen3-vl:8b" }, { llm: stubLlm(MINCE) });

    it("is found by searching the halves, and needs both", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);
      await row(db, "Lasagne nötfärs", "livsmedelsverket", 137);
      await row(db, "Nöt kött rå", "livsmedelsverket", 150);
      await row(db, "Nöt färs rå fett 10%", "livsmedelsverket", 182);
      expect((await read(app, user))?.name).toBe("Nöt färs rå fett 10%");
    });
  });
});

describe("readRecipe", () => {
  it("drops an empty line and an empty heading", () => {
    const outcome = readRecipe(
      JSON.stringify({ title: "", yield: null, rows: [{ line: " ", section: "" }, { line: "salt", section: "" }] }),
    );
    expect(outcome).toEqual({
      ok: true,
      recipe: { title: null, yield: null, rows: [{ line: "salt", section: null }] },
    });
  });

  it("refuses output that is not the shape", () => {
    expect(readRecipe("not json").ok).toBe(false);
    expect(readRecipe(JSON.stringify({ title: null, yield: null, rows: [{ amount: "1 dl" }] })).ok).toBe(false);
  });
});
