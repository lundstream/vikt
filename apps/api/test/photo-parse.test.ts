import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { PHOTO_CONFIDENCE, parsedPhotoSchema } from "shared";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import type { Db } from "../src/db/index.js";
import { foodEntries, foodItems } from "../src/db/schema.js";
import { PHOTO_SYSTEM_PROMPT, stripNutrition } from "../src/llm/parse-photo.js";
import { auth, createUser, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * What a photograph is allowed to say (D143).
 *
 * The transport is `photo-transport.test.ts`. This file is about the answer,
 * and the two rules it has to hold are both rules about **numbers the model is
 * not allowed to produce**:
 *
 * **An amount is a number with a unit the app can price, or it is nothing.**
 * The probe's models answered "stor mängd", "spridd över delar" and "1
 * portion", and every one of those is a description of a picture rather than a
 * quantity. They arrive as null, they stay null, and the row stays — because
 * the food was real even when the amount was not, and a dropped row is a meal
 * the person then has to notice is missing.
 *
 * **No nutrition figure survives, in any shape.** As a field it is refused by
 * the schema; written into a name it is cut out. There is one source of what
 * food is worth in this app and it is the database.
 */

function stubLlm(reply: ChatResult): LlmClient {
  return {
    enabled: true,
    chat: async () => reply,
    chatStream: async (_options, onDelta) => {
      if (reply.ok) onDelta(reply.content);
      return reply;
    },
    reachable: async () => true,
  };
}

/** The model's raw answer, exactly as it would arrive over the wire. */
const modelSays = (json: string): ChatResult => ({
  ok: true,
  content: json,
  model: "qwen3-vl:8b",
  ms: 13_100,
});

const VISION = { LLM_VISION_MODEL: "qwen3-vl:8b" } as const;

/** Enough base64 to get past the schema's floor. Its content is irrelevant. */
const IMAGE = Buffer.from("x".repeat(64)).toString("base64");

async function parse(app: FastifyInstance, user: TestUser) {
  const response = await app.inject({
    method: "POST",
    url: "/api/llm/parse-photo",
    headers: auth(user),
    payload: { image: IMAGE },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    available: boolean;
    reason?: string;
    items?: {
      name: string;
      estimatedGrams: number | null;
      portion: unknown;
      portionSource: string;
      match: { name: string; kcal: number | null } | null;
    }[];
  }>();
}

async function manualFood(
  app: FastifyInstance,
  user: TestUser,
  name: string,
  kcalPer100: number,
): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/api/food/manual",
    headers: auth(user),
    payload: { name, kcalPer100 },
  });
}

/** A shared food with a household category, which `/food/manual` cannot set. */
async function categorisedFood(
  db: Db,
  name: string,
  category: string,
  kcalPer100: number,
): Promise<void> {
  await db.insert(foodItems).values({
    source: "manual",
    name,
    kcalPer100: String(kcalPer100),
    category,
    visibility: "shared",
  });
}

/* ------------------------------------------------------- the three phrases */

describe('"stor mängd"', () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays('{"items":[{"name":"friterad potatis","amount":"stor mängd"}]}'),
    ),
  });

  /**
   * The answer the home plate actually produced. Not an object at all, which
   * is why the schema catches a malformed amount into null rather than
   * refusing the whole reply: one unquantified side dish must not throw away
   * the three foods beside it that the model got right.
   */
  it("keeps the food, with no amount and no invented one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Friterad potatis", 290);

    const body = await parse(app, user);

    expect(body.items).toHaveLength(1);
    const [item] = body.items ?? [];
    expect(item?.name).toBe("friterad potatis");
    expect(item?.estimatedGrams).toBeNull();
    expect(item?.portion).toBeNull();
    expect(item?.portionSource).toBe("unknown");
    // Matched, priced per hundred grams, and worth nothing in particular until
    // somebody says how much of it there was.
    expect(item?.match?.name).toBe("Friterad potatis");
    expect(item?.match?.kcal).toBeNull();
  });
});

describe('"spridd över delar"', () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays(
        '{"items":[{"name":"krämig dressing","amount":{"count":1,"unit":"spridd över delar"}}]}',
      ),
    ),
  });

  /**
   * The Caesar salad's answer, and the other shape the same non-answer takes:
   * a well-formed object whose unit is a sentence. A count of one multiplied by
   * a phrase is still not a mass.
   */
  it("is a unit the app cannot price, so there is no amount", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body.items?.[0]?.name).toBe("krämig dressing");
    expect(body.items?.[0]?.estimatedGrams).toBeNull();
    expect(body.items?.[0]?.portionSource).toBe("unknown");
  });
});

describe('"1 portion"', () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays('{"items":[{"name":"kebabpizza","amount":{"count":1,"unit":"portion"}}]}'),
    ),
  });

  /**
   * The subtle one. "portion" **is** a unit the household table knows, so the
   * word alone cannot decide this: what decides it is whether this food has a
   * portion defined. Yoghurt does, at 200 g. A kebab pizza does not, and
   * nothing anywhere says what a portion of kebab pizza weighs.
   */
  it("is not an amount when the food has no portion defined", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Pizza kebab", 240);

    const body = await parse(app, user);

    expect(body.items?.[0]?.match?.name).toBe("Pizza kebab");
    expect(body.items?.[0]?.estimatedGrams).toBeNull();
    expect(body.items?.[0]?.portionSource).toBe("unknown");
  });
});

describe("a portion that is defined", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays('{"items":[{"name":"yoghurt","amount":{"count":1,"unit":"portion"}}]}'),
    ),
  });

  /** The same word, and this time it resolves, because the table says 200 g. */
  it("resolves against the household table", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await categorisedFood(db, "Yoghurt naturell", "yoghurt", 60);

    const body = await parse(app, user);

    expect(body.items?.[0]?.estimatedGrams).toBe(200);
    expect(body.items?.[0]?.portionSource).toBe("hint");
    expect(body.items?.[0]?.match?.kcal).toBe(120);
  });
});

describe("grams and kilograms", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays(
        '{"items":[{"name":"kokt potatis","amount":{"count":250,"unit":"g"}},{"name":"nötfärs","amount":{"count":0.5,"unit":"kg"}}]}',
      ),
    ),
  });

  /** The units the app stores in. No table needed and none consulted. */
  it("resolve on their own", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body.items?.[0]?.estimatedGrams).toBe(250);
    expect(body.items?.[1]?.estimatedGrams).toBe(500);
  });
});

/* ---------------------------------------------- a weight printed on a label */

describe("a weight read off the packaging", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays(
        '{"items":[{"name":"Mammas köttbullar","amount":{"count":1000,"unit":"g"},"packageG":1000}]}',
      ),
    ),
  });

  /**
   * The defect this rule exists for. The model read "1000 G" off a bag of
   * meatballs and offered it as the amount; the database priced it at 2 173
   * kcal and the row was one tap from the day's intake.
   *
   * A kilo on a bag says what the bag weighs. The prompt asks for that figure
   * as `packageG`, and a row that carries one has **no amount** whatever the
   * model also put in `amount` — which is the half that matters, because a
   * model that follows the instruction perfectly would have sent null there
   * anyway and a model that ignores it is the case worth defending against.
   */
  it("is not the amount, even when the model puts it in both fields", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body.items?.[0]?.name).toBe("Mammas köttbullar");
    expect(body.items?.[0]?.estimatedGrams).toBeNull();
    expect(body.items?.[0]?.portionSource).toBe("unknown");
  });
});

describe("a package weight reported on its own", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays('{"items":[{"name":"Mammas köttbullar","amount":null,"packageG":1000}]}'),
    ),
  });

  /** The compliant shape. The food survives; the figure does not become one. */
  it("keeps the food and leaves the amount empty", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body.items?.[0]?.name).toBe("Mammas köttbullar");
    expect(body.items?.[0]?.estimatedGrams).toBeNull();
  });
});

describe("a plate weight that is not a package weight", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays('{"items":[{"name":"kokt potatis","amount":{"count":250,"unit":"g"}}]}'),
    ),
  });

  /**
   * The rule is about `packageG`, not about grams. An estimate of what is on
   * the plate is the most useful answer this path can give and is unaffected.
   */
  it("is still an amount", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body.items?.[0]?.estimatedGrams).toBe(250);
  });
});

/* ------------------------------------------------------------- no calories */

describe("a model that sends nutrition as a field", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays(
        '{"items":[{"name":"kebabpizza","amount":{"count":1,"unit":"st"},"kcal":1200}]}',
      ),
    ),
  });

  /**
   * Refused outright rather than stripped. A reply carrying calories is a reply
   * that did not follow the one instruction that matters, and the honest thing
   * to do with the rest of it is not to trust it either.
   */
  it("is unusable output, not a parse with the number quietly removed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body).toEqual({ available: false, reason: "unusable_output" });
  });
});

describe("a model that writes the calories into the name", () => {
  const ctx = useTestApp(VISION, {
    llm: stubLlm(
      modelSays(
        '{"items":[{"name":"kebabpizza (ca 1200 kcal)","amount":{"count":1,"unit":"st"}}]}',
      ),
    ),
  });

  /**
   * The same claim wearing different clothes, and the schema cannot see it: it
   * is a string in a field that is allowed to hold strings. Cut out of the name
   * rather than refused, because unlike a `kcal` field there is still a real
   * food in there to look up.
   */
  it("has the figure cut out and the food kept", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = await parse(app, user);

    expect(body.items?.[0]?.name).toBe("kebabpizza");
  });
});

describe("cutting nutrition out of a name", () => {
  it.each([
    ["kebabpizza (ca 1200 kcal)", "kebabpizza"],
    ["Kycklingfilé 250 kcal", "Kycklingfilé"],
    ["nötfärs, 20 g protein", "nötfärs"],
    ["havregryn energi: 370", "havregryn"],
    ["ost fett 28 g", "ost"],
  ])("%s becomes %s", (given, expected) => {
    expect(stripNutrition(given)).toBe(expected);
  });

  /**
   * And leaves ordinary numbers alone. A bare figure beside a food is an
   * amount, amounts have their own field and their own rules, and a cleaner
   * that ate them would silently rename foods whose names contain digits.
   */
  it("leaves a name that only contains an ordinary number", () => {
    expect(stripNutrition("Lätta 40 %")).toBe("Lätta 40 %");
    expect(stripNutrition("Coca-Cola Zero")).toBe("Coca-Cola Zero");
  });
});

/* ----------------------------------------------------------------- the prompt */

describe("the prompt", () => {
  /**
   * The example is the part of a prompt a model copies most literally, so an
   * example that has drifted from the schema is a prompt asking for output the
   * parser will refuse.
   */
  it("shows an example the parser would accept", () => {
    const example = PHOTO_SYSTEM_PROMPT.match(/\{"items".*\}\]\}/);
    expect(example).not.toBeNull();
    expect(parsedPhotoSchema.safeParse(JSON.parse(example?.[0] ?? "")).success).toBe(true);
  });

  /**
   * The instruction that decides how a plate is split. Not "one row per
   * ingredient" and not "one row per dish": one row per row in a food
   * database, which is what makes a kebab pizza one line and a steak dinner
   * three.
   */
  it("says a printed weight is the packet and not the meal", () => {
    expect(PHOTO_SYSTEM_PROMPT).toContain("TRYCKT PÅ FÖRPACKNINGEN");
    expect(PHOTO_SYSTEM_PROMPT).toContain("packageG");
    // And what an amount is instead: what is on the plate, when it can be seen.
    expect(PHOTO_SYSTEM_PROMPT).toContain("hur mycket som ligger på tallriken");
  });

  it("asks for the rows a food database would have", () => {
    expect(PHOTO_SYSTEM_PROMPT).toContain("livsmedelsdatabas");
    expect(PHOTO_SYSTEM_PROMPT).toContain("kebabpizza är EN rad");
    expect(PHOTO_SYSTEM_PROMPT).toContain("TRE rader");
    // A packaged product named as its label names it, so search has an exact
    // string to hit rather than a description to approximate.
    expect(PHOTO_SYSTEM_PROMPT).toContain("varumärke och produktnamn");
  });

  it("names the units an amount may use, and no others", () => {
    for (const unit of ["g", "kg", "dl", "msk", "portion", "skiva", "st"]) {
      expect(PHOTO_SYSTEM_PROMPT).toContain(unit);
    }
    // And it says what to do when it cannot judge one, which is the answer the
    // constrained model gives most of the time.
    expect(PHOTO_SYSTEM_PROMPT).toContain("sätt amount till null");
  });
});

/* ------------------------------------------------------- what gets saved */

describe("confirming rows that came from a photograph", () => {
  const ctx = useTestApp(VISION, { llm: stubLlm(modelSays('{"items":[]}')) });

  async function confirm(
    app: FastifyInstance,
    user: TestUser,
    body: Record<string, unknown>,
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload: {
        localDate: "2026-09-12",
        mealSlot: "snack",
        items: [
          {
            clientUuid: randomUUID(),
            foodItemId: null,
            name: "kebabpizza",
            grams: 450,
            kcal: 1080,
          },
        ],
        ...body,
      },
    });
    expect(response.statusCode).toBe(200);
    const [row] = await ctx()
      .db.select()
      .from(foodEntries)
      .where(eq(foodEntries.userId, user.userId));
    return row;
  }

  /**
   * Lowered, not excluded (D55, D143). The row is real and the database priced
   * it; what is less certain is that a model looking at a picture named the
   * right food. So it goes in with a confidence that says where it came from,
   * and the macro coverage counts it like any other priced row.
   */
  it("writes the batch's lowered confidence", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const row = await confirm(app, user, { confidence: PHOTO_CONFIDENCE });

    expect(Number(row?.confidence)).toBe(PHOTO_CONFIDENCE);
  });

  /** And a caller that says nothing gets what every caller got before. */
  it("defaults to full confidence when the field is absent", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const row = await confirm(app, user, {});

    expect(Number(row?.confidence)).toBe(1);
  });
});

/* --------------------------------------------------- the estimate path stays shut */

describe("the model estimate (D81)", () => {
  const ctx = useTestApp(VISION, { llm: stubLlm(modelSays('{"items":[]}')) });

  /**
   * A photograph does not license an estimate.
   *
   * D81's exception to D5 is conditioned on the app having *tried and failed*:
   * nothing found by search, and a decomposition that produced nothing or was
   * rejected. A photograph is none of those — it is a new input, not a
   * exhausted one — and the endpoint's `after` enum has no value for it, so the
   * path is shut at the schema rather than by a convention somebody has to
   * remember.
   */
  it("cannot be reached by saying a photo was taken", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/estimate",
      headers: auth(user),
      payload: { dish: "kebabpizza", after: "photo", requested: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "validation_failed" });
  });
});
