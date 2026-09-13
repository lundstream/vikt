import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * The optional layer at the API boundary (§6 phase 8).
 *
 * Two properties are tested here rather than in the unit file, because only the
 * endpoint can be wrong about them:
 *
 * **Unavailability is an ordinary answer.** A switched-off workstation gets a
 * 200 with `available: false`, not a 5xx. The brief's first sentence about this
 * phase is that nothing may depend on the layer and the degradation carries no
 * error banner; a 503 makes every client treat "the box is off" as a fault.
 *
 * **The nutrition comes from the database.** The stub model returns names and
 * grams only, and the calories in the response are the ones the food item
 * implies for that portion.
 */

/** A client that answers with whatever the test hands it. */
function stubLlm(reply: ChatResult, reachable = true): LlmClient {
  return {
    enabled: true,
    chat: async () => reply,
    /**
     * The coach's path (D139). These suites do not use it; it answers with the
     * same reply in one chunk so the stub stays a complete `LlmClient`.
     */
    chatStream: async (_options, onDelta) => {
      const result = reply;
      if (result.ok) onDelta(result.content);
      return result;
    },
    reachable: async () => reachable,
  };
}

const offLlm: LlmClient = {
  enabled: false,
  chat: async () => ({ ok: false, reason: "disabled" }),
  chatStream: async () => ({ ok: false, reason: "disabled" }),
  reachable: async () => false,
};

const modelSays = (items: unknown): ChatResult => ({
  ok: true,
  content: JSON.stringify({ items }),
  model: "gemma4:e4b",
  ms: 420,
});

async function manualFood(
  app: FastifyInstance,
  user: TestUser,
  name: string,
  kcalPer100: number,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/food/manual",
    headers: auth(user),
    payload: { name, kcalPer100 },
  });
  return response.json<{ id: string }>().id;
}

describe("when the workstation is off", () => {
  const ctx = useTestApp({}, { llm: offLlm });

  it("reports itself unconfigured rather than failing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: "/api/llm/health",
      headers: auth(user),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, reachable: false });
  });

  it("answers a parse with 200 and an unavailable result, not an error", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food",
      headers: auth(user),
      payload: { text: "två ägg och kaffe" },
    });

    // The whole point: a client can render this without an error banner.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: "disabled" });
  });
});

describe("parsing", () => {
  const ctx = useTestApp({}, {
    llm: stubLlm(
      modelSays([
        { name: "Testägg", estimatedGrams: 110, confidence: 0.9 },
        { name: "Något som inte finns", estimatedGrams: 50, confidence: 0.4 },
      ]),
    ),
  });

  it("takes the nutrition from the database, never from the model", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Testägg", 140);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/parse-food",
        headers: auth(user),
        payload: { text: "två ägg" },
      })
    ).json();

    expect(body.available).toBe(true);

    const matched = body.items[0];
    expect(matched.name).toBe("Testägg");
    expect(matched.estimatedGrams).toBe(110);
    // 110 g of a 140 kcal/100 g food. Computed here, from the row.
    expect(matched.match.kcal).toBe(154);
    expect(matched.match.kcalPer100).toBe(140);
  });

  it("returns an unmatched name with no nutrition rather than guessing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Testägg", 140);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/parse-food",
        headers: auth(user),
        payload: { text: "två ägg" },
      })
    ).json();

    const unmatched = body.items[1];
    expect(unmatched.name).toBe("Något som inte finns");
    // Null, not a near miss. The wrong food's calories are worse than none.
    expect(unmatched.match).toBeNull();
  });

  it("writes nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Testägg", 140);

    await app.inject({
      method: "POST",
      url: "/api/llm/parse-food",
      headers: auth(user),
      payload: { text: "två ägg" },
    });

    const entries = (
      await app.inject({
        method: "GET",
        url: `/api/food-entry?from=${localDate()}&to=${localDate()}`,
        headers: auth(user),
      })
    ).json().entries;

    // Nothing is logged until the user has seen the matches and confirmed.
    expect(entries).toHaveLength(0);
  });
});

describe("a model that ignores the rules", () => {
  const ctx = useTestApp({}, {
    llm: stubLlm(modelSays([{ name: "ägg", estimatedGrams: 110, confidence: 0.9, kcal: 155 }])),
  });

  it("is refused, and reported as unavailable rather than as a fault", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food",
      headers: auth(user),
      payload: { text: "två ägg" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: "unusable_output" });
  });
});

describe("confirming a parse", () => {
  const ctx = useTestApp({}, { llm: offLlm });

  it("writes the rows the user accepted, with the database's numbers", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Testägg", 140);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload: {
        localDate: localDate(),
        mealSlot: "breakfast",
        items: [
          // The user corrected 110 g down to 100 g before confirming.
          { clientUuid: randomUUID(), foodItemId, name: "Testägg", grams: 100 },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0].kcal).toBe(140);
  });

  /**
   * D74. This used to write the row with a zero and answer 200, which put a
   * silently low day into the series TDEE is computed from, and did it at the
   * one point where the app is doing the writing rather than the reporting.
   */
  it("refuses a row the database could not price and the user did not value", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload: {
        localDate: localDate(),
        items: [{ clientUuid: randomUUID(), foodItemId: null, name: "Mormors gryta", grams: 300 }],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("unpriced_items");
    // The name travels, so the screen can say which row is waiting.
    expect(response.json().message).toContain("Mormors gryta");
  });

  it("keeps an unmatched row as a note once the user has valued it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload: {
        localDate: localDate(),
        items: [
          {
            clientUuid: randomUUID(),
            foodItemId: null,
            name: "Mormors gryta",
            grams: 300,
            kcal: 420,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const entry = response.json().entries[0];
    expect(entry.name).toBe("Mormors gryta");
    expect(entry.kcal).toBe(420);
  });

  /** Zero is still allowed. It just has to have been chosen. */
  it("accepts a chosen zero, which is what negligible means", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload: {
        localDate: localDate(),
        items: [{ clientUuid: randomUUID(), foodItemId: null, name: "salt", grams: 2, kcal: 0 }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0].kcal).toBe(0);
  });

  it("is idempotent, like every other log write", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Testägg", 140);
    const clientUuid = randomUUID();

    const payload = {
      localDate: localDate(),
      items: [{ clientUuid, foodItemId, name: "Testägg", grams: 100 }],
    };

    await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload,
    });
    await app.inject({
      method: "POST",
      url: "/api/llm/parse-food/confirm",
      headers: auth(user),
      payload,
    });

    const entries = (
      await app.inject({
        method: "GET",
        url: `/api/food-entry?from=${localDate()}&to=${localDate()}`,
        headers: auth(user),
      })
    ).json().entries;

    expect(entries).toHaveLength(1);
  });
});

/**
 * The recipe generator (§6 phase 8, item 2).
 *
 * The property that matters is the same one: **the recipe's nutrition comes
 * from the database, not the model.** The stub returns a title, steps and named
 * amounts; every calorie in the response is one the food item implies.
 */
const recipeSays = (recipe: unknown): ChatResult => ({
  ok: true,
  content: JSON.stringify(recipe),
  model: "qwen3.6:27b",
  ms: 8000,
});

/**
 * A recipe a person could actually cook.
 *
 * The fixtures used to be two sentences long, which is a fair model of what a
 * model produces and is no longer a fair model of what the app accepts (D74):
 * the completeness rules require the food to be cooked, seasoned, finished and
 * every ingredient used. A stub that fails them tests the retry, not the path.
 */
const COOKABLE = {
  title: "Omelett med spenat",
  steps: [
    "Hacka spenaten grovt.",
    "Vispa äggen och stek dem i panna i fem minuter.",
    "Salta och peppra.",
    "Servera omeletten med spenaten.",
  ],
  items: [
    { name: "Testägg", estimatedGrams: 150, confidence: 0.9 },
    { name: "Spenat som inte finns", estimatedGrams: 60, confidence: 0.7 },
  ],
};

describe("generating a recipe", () => {
  const ctx = useTestApp({}, {
    llm: stubLlm(
      recipeSays(COOKABLE),
    ),
  });

  it("prices the ingredients from the database", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Testägg", 140);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "ägg, spenat" },
      })
    ).json();

    expect(body.available).toBe(true);
    expect(body.title).toBe("Omelett med spenat");
    expect(body.steps).toHaveLength(4);

    // 150 g of a 140 kcal/100 g food.
    expect(body.items[0].match.kcal).toBe(210);
    // The total is over priced rows only, and says it is not the whole dish.
    expect(body.total.kcal).toBe(210);
    expect(body.total.complete).toBe(false);
    expect(body.total.missing).toEqual(["Spenat som inte finns"]);
  });

  it("leaves an unmatched ingredient without a number", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Testägg", 140);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "ägg, spenat" },
      })
    ).json();

    // Visible on the screen with no energy, so the reader can see what the
    // total is missing rather than being given a confident low number.
    expect(body.items[1].match).toBeNull();
  });

  it("writes nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Testägg", 140);

    await app.inject({
      method: "POST",
      url: "/api/llm/recipe",
      headers: auth(user),
      payload: { localDate: localDate(), have: "ägg" },
    });

    const entries = (
      await app.inject({
        method: "GET",
        url: `/api/food-entry?from=${localDate()}&to=${localDate()}`,
        headers: auth(user),
      })
    ).json().entries;

    expect(entries).toHaveLength(0);
  });

  it("reports the budget it worked to", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "ägg" },
      })
    ).json();

    // No plan on a fresh account, so no budget. Null, never a fabricated zero.
    expect(body.budget).toMatchObject({ kcal: null, proteinG: null, approximate: false });
  });
});

describe("a recipe with an invented calorie count", () => {
  const ctx = useTestApp({}, {
    llm: stubLlm(
      recipeSays({
        ...COOKABLE,
        steps: ["Stek äggen i smör i fem minuter, cirka 300 kcal.", "Salta och servera."],
      }),
    ),
  });

  it("is refused even though the figure is only in the prose", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/recipe",
      headers: auth(user),
      payload: { localDate: localDate(), have: "ägg" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: "unusable_output" });
  });
});

describe("a recipe when the workstation is off", () => {
  const ctx = useTestApp({}, { llm: offLlm });

  it("answers 200 with an unavailable result", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/recipe",
      headers: auth(user),
      payload: { localDate: localDate(), have: "ägg" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: "disabled" });
  });
});
