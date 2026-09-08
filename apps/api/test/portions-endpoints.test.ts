import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * Portions, pantry staples and saved recipes at the API boundary.
 *
 * The through-line is the one from §1 of this phase: **grams are what is
 * stored, and a portion is how a person says it.** Every test here either
 * checks that a stated portion reaches grams correctly, or that the app admits
 * when it could not.
 */

function stubLlm(replies: ChatResult[]): LlmClient {
  let call = 0;
  return {
    enabled: true,
    // Successive calls get successive replies; the last one repeats, so a test
    // that only cares about one answer does not have to count attempts.
    chat: async () => replies[Math.min(call++, replies.length - 1)]!,
    reachable: async () => true,
  };
}

const says = (body: unknown): ChatResult => ({
  ok: true,
  content: JSON.stringify(body),
  model: "test",
  ms: 100,
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

const COOKABLE = {
  title: "Skinkmacka",
  steps: [
    "Bred smör på brödet.",
    "Lägg på skinkan.",
    "Salta lätt och servera.",
  ],
  items: [{ name: "Rökt skinka", portion: { count: 5, unit: "skivor" }, estimatedGrams: 200, confidence: 0.8 }],
};

/* --------------------------------------------------------------- portions */

describe("defining a portion for a food", () => {
  const ctx = useTestApp();

  it("stores it, lists it, changes it and removes it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rågbröd", 240);

    const created = await app.inject({
      method: "POST",
      url: "/api/portions",
      headers: auth(user),
      payload: { foodItemId, unit: "skiva", grams: 35 },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;

    const listed = await app.inject({ method: "GET", url: "/api/portions", headers: auth(user) });
    expect(listed.json().portions).toHaveLength(1);
    expect(listed.json().portions[0]).toMatchObject({ unit: "skiva", grams: 35 });

    // Edit and delete ship with the create (§3, D56).
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/portions/${id}`,
      headers: auth(user),
      payload: { grams: 42 },
    });
    expect(edited.json().grams).toBe(42);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/portions/${id}`,
      headers: auth(user),
    });
    expect(deleted.statusCode).toBe(200);

    const empty = await app.inject({ method: "GET", url: "/api/portions", headers: auth(user) });
    expect(empty.json().portions).toEqual([]);
  });

  /** "Skiva" twice is one portion corrected, not two portions that disagree. */
  it("treats the same unit under a different spelling as the same portion", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rågbröd", 240);

    for (const [unit, grams] of [
      ["skiva", 35],
      ["Skivor", 42],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/api/portions",
        headers: auth(user),
        payload: { foodItemId, unit, grams },
      });
    }

    const listed = await app.inject({ method: "GET", url: "/api/portions", headers: auth(user) });
    expect(listed.json().portions).toHaveLength(1);
    expect(listed.json().portions[0].grams).toBe(42);
  });

  it("is another user's business only", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    const foodItemId = await manualFood(app, mine, "Rågbröd", 240);

    const created = await app.inject({
      method: "POST",
      url: "/api/portions",
      headers: auth(mine),
      payload: { foodItemId, unit: "skiva", grams: 35 },
    });

    const theirList = await app.inject({
      method: "GET",
      url: "/api/portions",
      headers: auth(theirs),
    });
    expect(theirList.json().portions).toEqual([]);

    const theirDelete = await app.inject({
      method: "DELETE",
      url: `/api/portions/${created.json().id}`,
      headers: auth(theirs),
    });
    expect(theirDelete.statusCode).toBe(404);
  });
});

/* --------------------------------------------- portions through the parser */

describe("a counted portion in free text", () => {
  const ctx = useTestApp({}, {
    llm: stubLlm([
      says({
        items: [
          {
            name: "Rökt skinka",
            portion: { count: 5, unit: "skivor" },
            estimatedGrams: 200,
            confidence: 0.6,
          },
        ],
      }),
    ]),
  });

  /**
   * "fem tunna skivor rökt skinka". The count is the part that is known, and
   * the app is the only participant that can look up what a slice weighs.
   */
  it("resolves against the user's own portion rather than the model's guess", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rökt skinka", 110);

    await app.inject({
      method: "POST",
      url: "/api/portions",
      headers: auth(user),
      payload: { foodItemId, unit: "skiva", grams: 12 },
    });

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/parse-food",
        headers: auth(user),
        payload: { text: "fem tunna skivor rökt skinka" },
      })
    ).json();

    const item = body.items[0];
    // 5 × 12 g, not the model's 200 g.
    expect(item.estimatedGrams).toBe(60);
    expect(item.portionSource).toBe("user_hint");
    expect(item.portion).toEqual({ count: 5, unit: "skivor" });
    // And the energy follows the resolved grams, not the estimate.
    expect(item.match.kcal).toBeCloseTo(66, 1);
  });

  /**
   * A food with no hint still resolves to grams, and still says the figure is
   * a guess. That is the whole requirement: visible, not silent.
   */
  it("falls back to the estimate and marks it as one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await manualFood(app, user, "Rökt skinka", 110);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/parse-food",
        headers: auth(user),
        payload: { text: "fem tunna skivor rökt skinka" },
      })
    ).json();

    expect(body.items[0].estimatedGrams).toBe(200);
    expect(body.items[0].portionSource).toBe("estimate");
    // The label survives, which is what makes a wrong estimate spottable.
    expect(body.items[0].portion).toEqual({ count: 5, unit: "skivor" });
  });
});

/* ------------------------------------------------------------ the recipe */

describe("a recipe that is not usable as instructions", () => {
  const halfBaked = says({
    title: "Torsk i ugn",
    steps: ["Lägg torsken i en ugnsform."],
    items: [{ name: "Torsk", estimatedGrams: 200, confidence: 0.9 }],
  });

  describe("when the second attempt is better", () => {
    const ctx = useTestApp({}, { llm: stubLlm([halfBaked, says(COOKABLE)]) });

    it("regenerates once and returns the good one", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);
      await manualFood(app, user, "Rökt skinka", 110);

      const body = (
        await app.inject({
          method: "POST",
          url: "/api/llm/recipe",
          headers: auth(user),
          payload: { localDate: localDate(), have: "bröd, skinka" },
        })
      ).json();

      expect(body.available).toBe(true);
      expect(body.title).toBe("Skinkmacka");
    });
  });

  describe("what gets logged", () => {
    const ctx = useTestApp({}, { llm: stubLlm([halfBaked, says(COOKABLE)]) });

    /**
     * The completeness rules are a proxy for "a person could cook this", and
     * the only way to tell whether the proxy is any good is to look at what it
     * rejects on real cases. That means the rule names have to reach the log.
     */
    it("names the rules that failed", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);

      const warnings: { rules?: string[] }[] = [];
      const realWarn = app.log.warn.bind(app.log);
      app.log.warn = ((details: object, message?: string) => {
        if (message === "recipe failed completeness") warnings.push(details);
        return realWarn(details as never, message as never);
      }) as typeof app.log.warn;

      await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "torsk" },
      });

      app.log.warn = realWarn;

      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.rules).toContain("oven_without_temperature");
      expect(warnings[0]!.rules).toContain("seasoning_unstated");
    });
  });

  describe("when both attempts fail", () => {
    const ctx = useTestApp({}, { llm: stubLlm([halfBaked]) });

    /**
     * Not a half-recipe with a warning. Someone starts cooking that.
     */
    it("says it could not manage rather than showing a broken recipe", async () => {
      const { app, db } = ctx();
      const user = await createUser(app, db);

      const response = await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "torsk" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ available: false, reason: "incomplete_recipe" });
    });
  });
});

describe("a recipe's ingredient list", () => {
  const ctx = useTestApp({}, { llm: stubLlm([says(COOKABLE)]) });

  it("carries the portion so it can be read at a chopping board", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rökt skinka", 110);
    await app.inject({
      method: "POST",
      url: "/api/portions",
      headers: auth(user),
      payload: { foodItemId, unit: "skiva", grams: 12 },
    });

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "bröd, skinka" },
      })
    ).json();

    expect(body.items[0].portion).toEqual({ count: 5, unit: "skivor" });
    expect(body.items[0].estimatedGrams).toBe(60);
  });

  /** D74: an incomplete total is not a total. */
  it("says when the total is not the whole dish", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({
        method: "POST",
        url: "/api/llm/recipe",
        headers: auth(user),
        payload: { localDate: localDate(), have: "bröd, skinka" },
      })
    ).json();

    expect(body.total).toEqual({ kcal: null, complete: false, missing: ["Rökt skinka"] });
  });
});

/* -------------------------------------------------------- pantry staples */

describe("pantry staples", () => {
  const ctx = useTestApp();

  it("seeds a list to prune rather than an empty box", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const listed = await app.inject({ method: "GET", url: "/api/pantry", headers: auth(user) });
    const staples = listed.json().staples;

    expect(staples.length).toBeGreaterThan(5);
    expect(staples.map((s: { name: string }) => s.name)).toContain("salt");
    expect(staples.map((s: { name: string }) => s.name)).toContain("olivolja");
  });

  /**
   * The distinction §6 is emphatic about: salt may be assumed silently, oil may
   * not, because three tablespoons of oil is roughly 360 kcal.
   */
  it("classes seasonings as negligible and fats as not", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const staples = (
      await app.inject({ method: "GET", url: "/api/pantry", headers: auth(user) })
    ).json().staples;

    const by = (name: string) =>
      staples.find((s: { name: string }) => s.name === name) as { negligible: boolean };

    expect(by("salt").negligible).toBe(true);
    expect(by("olivolja").negligible).toBe(false);
    expect(by("ris").negligible).toBe(false);
  });

  /**
   * An emptied list is a legitimate state. A count-based guard would re-seed
   * the list the user had just cleared, forever (§3).
   */
  it("does not re-seed a list the user emptied", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const first = (
      await app.inject({ method: "GET", url: "/api/pantry", headers: auth(user) })
    ).json().staples;

    for (const staple of first) {
      await app.inject({
        method: "DELETE",
        url: `/api/pantry/${staple.id}`,
        headers: auth(user),
      });
    }

    const second = (
      await app.inject({ method: "GET", url: "/api/pantry", headers: auth(user) })
    ).json().staples;
    expect(second).toEqual([]);
  });

  it("takes an addition, an edit and a removal", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await app.inject({ method: "GET", url: "/api/pantry", headers: auth(user) });

    const added = await app.inject({
      method: "POST",
      url: "/api/pantry",
      headers: auth(user),
      payload: { name: "sesamolja" },
    });
    expect(added.statusCode).toBe(200);
    const id = added.json().id;

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/pantry/${id}`,
      headers: auth(user),
      payload: { negligible: true },
    });
    expect(edited.json().negligible).toBe(true);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/pantry/${id}`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(200);
  });
});

/* --------------------------------------------------------- saved recipes */

describe("saving a recipe", () => {
  const ctx = useTestApp();

  const recipe = (foodItemId: string | null) => ({
    title: "Skinkmacka",
    steps: ["Bred smör på brödet.", "Lägg på skinkan och servera."],
    items: [
      { name: "Rökt skinka", grams: 60, foodItemId, portion: { count: 5, unit: "skivor" } },
    ],
  });

  it("keeps the text and generates the template that cooks it again", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rökt skinka", 110);

    const saved = await app.inject({
      method: "POST",
      url: "/api/recipes",
      headers: auth(user),
      payload: recipe(foodItemId),
    });

    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.title).toBe("Skinkmacka");
    expect(body.steps).toHaveLength(2);
    // §6: a recipe holds the prose, a template holds the rows, and they link.
    expect(body.templateId).not.toBeNull();
    // The portion label survives, so a reopened recipe still reads "5 skivor".
    expect(body.items[0].portion).toEqual({ count: 5, unit: "skivor" });

    const templates = (
      await app.inject({ method: "GET", url: "/api/meal-templates", headers: auth(user) })
    ).json().templates;
    expect(templates.map((t: { name: string }) => t.name)).toContain("Skinkmacka");
  });

  it("is editable, which is the whole point of keeping one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rökt skinka", 110);

    const id = (
      await app.inject({
        method: "POST",
        url: "/api/recipes",
        headers: auth(user),
        payload: recipe(foodItemId),
      })
    ).json().id;

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/recipes/${id}`,
      headers: auth(user),
      payload: { steps: ["Rosta brödet först.", "Lägg på skinkan och servera."] },
    });

    expect(edited.json().steps[0]).toBe("Rosta brödet först.");
    // Editing the method does not touch the title or the ingredients.
    expect(edited.json().title).toBe("Skinkmacka");
    expect(edited.json().items).toHaveLength(1);
  });

  it("deletes", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const foodItemId = await manualFood(app, user, "Rökt skinka", 110);

    const id = (
      await app.inject({
        method: "POST",
        url: "/api/recipes",
        headers: auth(user),
        payload: recipe(foodItemId),
      })
    ).json().id;

    expect(
      (await app.inject({ method: "DELETE", url: `/api/recipes/${id}`, headers: auth(user) }))
        .statusCode,
    ).toBe(200);

    expect(
      (await app.inject({ method: "GET", url: "/api/recipes", headers: auth(user) })).json()
        .recipes,
    ).toEqual([]);
  });

  /**
   * A recipe whose ingredients the database cannot price has nothing to put in
   * a template: every application of it would write zero-energy rows (D74).
   */
  it("skips the template when nothing could be priced", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const saved = await app.inject({
      method: "POST",
      url: "/api/recipes",
      headers: auth(user),
      payload: recipe(null),
    });

    expect(saved.json().templateId).toBeNull();
  });
});
