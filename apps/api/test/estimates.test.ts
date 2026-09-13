import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * Restaurant food, in the three shapes it actually arrives in (D80, D81).
 *
 * The rule underneath all of it: **an entry with no determinable energy is not
 * logged silently.** An estimate is a number someone chose, marked as chosen,
 * and reusable so that the same pizzeria does not produce a different figure
 * every Friday.
 */

function stubLlm(reply: ChatResult): LlmClient {
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
    reachable: async () => true,
  };
}

const says = (body: unknown): ChatResult => ({
  ok: true,
  content: JSON.stringify(body),
  model: "qwen3.6:27b",
  ms: 3000,
});

const GOOD_ESTIMATE = {
  kcal: 780,
  kcalLow: 650,
  kcalHigh: 950,
  proteinG: 38,
  carbsG: 62,
  fatG: 40,
  grams: 420,
  basis: "Ungefär en dubbelburgare med bröd, ost och dressing.",
};

/* ------------------------------------------------- typed estimates (D80) */

describe("an estimated restaurant meal", () => {
  const ctx = useTestApp();

  const pizza = {
    name: "Kebabpizza",
    brand: "Pizzeria Roma",
    kcal: 1200,
    grams: 500,
    proteinG: 45,
    basis: "Stor pizza, åt hela",
  };

  it("is stored as a reusable food item, marked as an estimate", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const created = await app.inject({
      method: "POST",
      url: "/api/food/estimate",
      headers: auth(user),
      payload: pizza,
    });

    expect(created.statusCode).toBe(200);
    const item = created.json();
    expect(item.isEstimate).toBe(true);
    expect(item.estimateBasis).toBe("Stor pizza, åt hela");
    // The user gave a portion; the cache stores per 100 g, derived from it.
    expect(item.kcalPer100).toBe(240);
    expect(item.proteinPer100).toBe(9);
    // And the portion comes back as a serving hint, so logging it again does
    // not ask the same unanswerable question twice.
    expect(item.servingHints).toEqual({ portion: 500 });
  });

  /** One person's guess about one restaurant is nobody else's data. */
  it("is private to the person who guessed it", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/food/estimate",
      headers: auth(mine),
      payload: pizza,
    });

    const found = (
      await app.inject({
        method: "GET",
        url: "/api/food/search?q=Kebabpizza",
        headers: auth(theirs),
      })
    ).json();

    expect(found.items.map((i: { name: string }) => i.name)).not.toContain("Kebabpizza");
  });

  it("is findable and loggable again, which is the point of remembering it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const id = (
      await app.inject({
        method: "POST",
        url: "/api/food/estimate",
        headers: auth(user),
        payload: pizza,
      })
    ).json().id;

    const found = (
      await app.inject({
        method: "GET",
        url: "/api/food/search?q=Kebabpizza",
        headers: auth(user),
      })
    ).json();
    expect(found.items[0].id).toBe(id);

    const logged = await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        foodItemId: id,
        grams: 500,
        confidence: 1,
        confirmed: true,
      },
    });

    expect(logged.statusCode).toBe(200);
    // The same 1200 kcal that was typed, not a re-guess.
    expect(logged.json().kcal).toBe(1200);
  });
});

/* ------------------------------------------------------- favourites (D80) */

describe("starring a food", () => {
  const ctx = useTestApp();

  it("keeps it within reach without searching, and unstars again", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const id = (
      await app.inject({
        method: "POST",
        url: "/api/food/estimate",
        headers: auth(user),
        payload: { name: "Kebabpizza", kcal: 1200, grams: 500 },
      })
    ).json().id;

    await app.inject({
      method: "POST",
      url: "/api/food/favourite",
      headers: auth(user),
      payload: { foodItemId: id, favourite: true },
    });

    const starred = (
      await app.inject({ method: "GET", url: "/api/food/favourites", headers: auth(user) })
    ).json();
    expect(starred.items).toHaveLength(1);
    expect(starred.items[0].favourite).toBe(true);
    expect(starred.items[0].isEstimate).toBe(true);

    await app.inject({
      method: "POST",
      url: "/api/food/favourite",
      headers: auth(user),
      payload: { foodItemId: id, favourite: false },
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/food/favourites", headers: auth(user) }))
        .json().items,
    ).toEqual([]);
  });

  it("is one person's star, not the table's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    const id = (
      await app.inject({
        method: "POST",
        url: "/api/food/manual",
        headers: auth(mine),
        payload: { name: "Havregryn", kcalPer100: 357 },
      })
    ).json().id;

    await app.inject({
      method: "POST",
      url: "/api/food/favourite",
      headers: auth(mine),
      payload: { foodItemId: id, favourite: true },
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/food/favourites", headers: auth(theirs) }))
        .json().items,
    ).toEqual([]);
  });

  it("starring twice is one star", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const id = (
      await app.inject({
        method: "POST",
        url: "/api/food/estimate",
        headers: auth(user),
        payload: { name: "Kebabpizza", kcal: 1200, grams: 500 },
      })
    ).json().id;

    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/food/favourite",
        headers: auth(user),
        payload: { foodItemId: id, favourite: true },
      });
    }

    expect(
      (await app.inject({ method: "GET", url: "/api/food/favourites", headers: auth(user) }))
        .json().items,
    ).toHaveLength(1);
  });
});

/* ------------------------------------- the narrow model exception (D81) */

describe("asking the model what a dish is worth", () => {
  const ctx = useTestApp({}, { llm: stubLlm(says(GOOD_ESTIMATE)) });

  const ask = (over: Record<string, unknown> = {}) => ({
    dish: "dubbel cheeseburgare med pommes",
    after: "decomposed_rejected",
    requested: true,
    ...over,
  });

  it("answers with a range and what it was based on", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/estimate",
        headers: auth(user),
        payload: ask(),
      })
    ).json();

    expect(body.available).toBe(true);
    expect(body.kcal).toBe(780);
    expect(body.kcalLow).toBe(650);
    expect(body.kcalHigh).toBe(950);
    // What it was based on travels, so the number can be judged not just taken.
    expect(body.basis).toContain("dubbelburgare");
  });

  /** An estimate is never a measurement, however sure the model sounds. */
  it("never reports full confidence", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/estimate",
        headers: auth(user),
        payload: ask(),
      })
    ).json();

    expect(body.confidence).toBeLessThan(1);
    expect(body.confidence).toBeGreaterThan(0);
  });

  it("writes nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/llm/estimate",
      headers: auth(user),
      payload: ask(),
    });

    const entries = (
      await app.inject({
        method: "GET",
        url: `/api/food-entry?from=${localDate()}&to=${localDate()}`,
        headers: auth(user),
      })
    ).json().entries;
    expect(entries).toEqual([]);
  });

  /**
   * The preconditions are the exception. Without them this is just D5 being
   * broken, so they are in the schema and the route refuses without them.
   */
  it("refuses unless the user actually asked", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/estimate",
      headers: auth(user),
      payload: { dish: "dubbel cheeseburgare", after: "not_found" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses unless the app already tried to find or decompose it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/estimate",
      headers: auth(user),
      payload: { dish: "dubbel cheeseburgare", requested: true },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("a model estimate that does not add up", () => {
  const ctx = useTestApp({}, {
    llm: stubLlm(says({ ...GOOD_ESTIMATE, kcal: 300, kcalLow: 650, kcalHigh: 950 })),
  });

  /**
   * A point figure outside its own range is a model that has not understood the
   * question, and its number is worth no more than its arithmetic.
   */
  it("is refused rather than shown", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm/estimate",
      headers: auth(user),
      payload: { dish: "burgare", after: "not_found", requested: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: false, reason: "unusable_output" });
  });
});
