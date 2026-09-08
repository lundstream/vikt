import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { NormaliseResult } from "shared";
import { foodItems, mealTemplateItems, users } from "../src/db/schema.js";
import type { FoodAdapter } from "../src/food/adapter.js";
import { AdapterUnavailable } from "../src/food/adapter.js";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * `useTestApp` registers Vitest hooks, so it has to run once at file level. The
 * app therefore gets a *delegating* adapter, and each test swaps what it
 * delegates to — rather than building an app per test, which would register
 * hooks from inside a test and never run them.
 */
let current: (FoodAdapter & { lookups: number; searches: number }) | null = null;

const delegating: FoodAdapter = {
  source: "openfoodfacts",
  supportsBarcode: true,
  lookupBarcode: (barcode, signal) => current!.lookupBarcode(barcode, signal),
  search: (query, limit, signal) => current!.search(query, limit, signal),
};

const ctx = useTestApp({}, { foodAdapters: [delegating] });

/** An adapter that answers from memory and counts how often it was consulted. */
function fakeAdapter(options: {
  barcodes?: Record<string, NormaliseResult | null>;
  search?: NormaliseResult[];
  unavailable?: boolean;
}): FoodAdapter & { lookups: number; searches: number } {
  const adapter = {
    source: "openfoodfacts" as const,
    supportsBarcode: true,
    lookups: 0,
    searches: 0,
    async lookupBarcode(barcode: string) {
      adapter.lookups += 1;
      if (options.unavailable) {
        throw new AdapterUnavailable("openfoodfacts", "nope", 30_000);
      }
      return options.barcodes?.[barcode] ?? null;
    },
    async search() {
      adapter.searches += 1;
      if (options.unavailable) {
        throw new AdapterUnavailable("openfoodfacts", "nope", 30_000);
      }
      return options.search ?? [];
    },
  };
  return adapter;
}

const havregryn: NormaliseResult = {
  ok: true,
  food: {
    source: "openfoodfacts",
    sourceRef: "7310865004703",
    barcode: "7310865004703",
    name: "Havregryn",
    brand: "AXA",
    // 1500 kJ, converted.
    kcalPer100: 358.51,
    sourceEnergyUnit: "kJ",
    macros: { proteinG: 13, carbsG: 58, fatG: null, fiberG: 10, saltG: null },
    servingHints: null,
  },
};

describe("barcode lookup", () => {
  it("caches a looked-up product so the second lookup never hits the network", async () => {
    const adapter = (current = fakeAdapter({ barcodes: { "7310865004703": havregryn } }));
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const first = await app.inject({
      method: "GET",
      url: "/api/food/barcode/7310865004703",
      headers: auth(user),
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/food/barcode/7310865004703",
      headers: auth(user),
    });

    expect(first.json<{ item: { name: string } }>().item.name).toBe("Havregryn");
    expect(second.json<{ item: { name: string } }>().item.name).toBe("Havregryn");
    expect(second.json<{ cacheOnly: boolean }>().cacheOnly).toBe(true);
    // The shared 15-a-minute budget is spent once, not twice.
    expect(adapter.lookups).toBe(1);
  });

  it("stores the converted kcal, not the source's kJ number", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: "/api/food/barcode/7310865004703",
      headers: auth(user),
    });

    const item = response.json<{ item: { kcalPer100: number } }>().item;
    expect(item.kcalPer100).toBeCloseTo(358.51, 2);
    expect(item.kcalPer100).not.toBeCloseTo(1500, 0);
  });

  it("reports a product whose energy cannot be trusted rather than importing it", async () => {
    current = fakeAdapter({
      barcodes: {
        "1111111111111": {
          ok: false,
          failure: { reason: "unknown_energy_unit", message: "Skriv in kalorierna själv." },
        },
      },
    });
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/1111111111111",
        headers: auth(user),
      })
    ).json<{ item: unknown; problem: { reason: string } }>();

    expect(body.item).toBeNull();
    expect(body.problem.reason).toBe("unknown_energy_unit");

    // And nothing was written to the cache.
    const rows = await db.select().from(foodItems);
    expect(rows).toHaveLength(0);
  });

  it("degrades to cache-only with a message when the source is unavailable", async () => {
    current = fakeAdapter({ unavailable: true });
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(user),
      })
    ).json<{ item: unknown; cacheOnly: boolean; notice: string }>();

    expect(body.item).toBeNull();
    expect(body.cacheOnly).toBe(true);
    expect(body.notice).toMatch(/otillgänglig/);
  });

  it("refuses a barcode that is not a barcode", async () => {
    current = fakeAdapter({});
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: "/api/food/barcode/not-a-barcode",
      headers: auth(user),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("search", () => {
  it("refuses a query shorter than the minimum, so it cannot be wired to keystrokes", async () => {
    const adapter = (current = fakeAdapter({ search: [havregryn] }));
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "GET",
      url: "/api/food/search?q=ha",
      headers: auth(user),
    });

    expect(response.statusCode).toBe(400);
    expect(adapter.searches).toBe(0);
  });

  it("answers from the cache without touching the network when it can", async () => {
    const adapter = (current = fakeAdapter({ search: [havregryn] }));
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // First search populates the cache.
    await app.inject({
      method: "GET",
      url: "/api/food/search?q=havregryn&limit=1",
      headers: auth(user),
    });
    const searchesAfterFirst = adapter.searches;

    const second = await app.inject({
      method: "GET",
      url: "/api/food/search?q=havregryn&limit=1",
      headers: auth(user),
    });

    expect(second.json<{ cacheOnly: boolean }>().cacheOnly).toBe(true);
    expect(adapter.searches).toBe(searchesAfterFirst);
  });

  it("still returns cached results when the network is unavailable", async () => {
    const good = (current = fakeAdapter({ search: [havregryn] }));
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "GET",
      url: "/api/food/search?q=havregryn&limit=5",
      headers: auth(user),
    });

    // Now make the adapter fail and search again.
    good.searches = 0;
    const body = (
      await app.inject({
        method: "GET",
        url: "/api/food/search?q=havregryn&limit=5",
        headers: auth(user),
      })
    ).json<{ items: unknown[] }>();

    expect(body.items.length).toBeGreaterThan(0);
  });
});

describe("food entries", () => {
  async function cachedItem(app: FastifyInstance, user: TestUser) {
    const response = await app.inject({
      method: "GET",
      url: "/api/food/barcode/7310865004703",
      headers: auth(user),
    });
    return response.json<{ item: { id: string } }>().item;
  }

  it("computes energy from the food item, not from what the client sent", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = await cachedItem(app, user);

    const response = await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        foodItemId: item.id,
        grams: 50,
        // A number the client has no business supplying.
        kcal: 9999,
      },
    });

    // 358.51 per 100 g, halved.
    expect(response.json<{ kcal: number }>().kcal).toBeCloseTo(179.3, 0);
  });

  it("is idempotent on client_uuid, like every other log write", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = await cachedItem(app, user);
    const clientUuid = randomUUID();

    const payload = {
      clientUuid,
      localDate: localDate(),
      foodItemId: item.id,
      grams: 50,
    };
    const first = await app.inject({ method: "POST", url: "/api/food-entry", headers: auth(user), payload });
    const second = await app.inject({ method: "POST", url: "/api/food-entry", headers: auth(user), payload });

    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const list = await app.inject({ method: "GET", url: "/api/food-entry", headers: auth(user) });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });

  it("keeps an unknown macro unknown after scaling", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = await cachedItem(app, user);

    const entry = (
      await app.inject({
        method: "POST",
        url: "/api/food-entry",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(),
          foodItemId: item.id,
          grams: 100,
        },
      })
    ).json<{ proteinG: number | null; fatG: number | null }>();

    expect(entry.proteinG).toBeCloseTo(13, 1);
    // The product does not state fat, so the entry does not either.
    expect(entry.fatG).toBeNull();
  });

  it("refuses a freetext entry with no energy rather than logging zero", async () => {
    current = fakeAdapter({});
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        freetext: "något jag åt",
        grams: 150,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: string }>().error).toBe("no_energy");
  });

  it("accepts a freetext entry with a typed estimate, marked as one", async () => {
    current = fakeAdapter({});
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const entry = (
      await app.inject({
        method: "POST",
        url: "/api/food-entry",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(),
          freetext: "restaurangmiddag",
          grams: 400,
          kcal: 800,
          confidence: 0.5,
        },
      })
    ).json<{ kcal: number; confidence: number; name: string }>();

    expect(entry.kcal).toBe(800);
    expect(entry.confidence).toBe(0.5);
    expect(entry.name).toBe("restaurangmiddag");
  });

  it("keeps one user's entries out of another's", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);
    const item = await cachedItem(app, bob);

    await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(bob),
      payload: { clientUuid: randomUUID(), localDate: localDate(), foodItemId: item.id, grams: 50 },
    });

    const asAlice = await app.inject({ method: "GET", url: "/api/food-entry", headers: auth(alice) });
    expect(asAlice.json<{ entries: unknown[] }>().entries).toEqual([]);
  });
});

/**
 * D17, the half that was deferred. Deleting a user must not turn their private
 * food public.
 */
describe("private foods stay private when their creator is deleted", () => {
  it("does not become shared", async () => {
    current = fakeAdapter({});
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);

    const created = await app.inject({
      method: "POST",
      url: "/api/food/manual",
      headers: auth(alice),
      payload: { name: "Mammas köttbullar", kcalPer100: 250 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ visibility: string }>().visibility).toBe("private");

    // Bob cannot see it while Alice exists.
    const beforeDelete = await app.inject({
      method: "GET",
      url: "/api/food/search?q=köttbullar",
      headers: auth(bob),
    });
    expect(beforeDelete.json<{ items: unknown[] }>().items).toEqual([]);

    await db.delete(users).where(eq(users.id, alice.userId));

    // The FK really did go null — this is the condition that used to leak.
    const [row] = await db.select().from(foodItems);
    expect(row?.createdBy).toBeNull();
    expect(row?.visibility).toBe("private");

    // And it is still invisible to Bob.
    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/food/search?q=köttbullar",
      headers: auth(bob),
    });
    expect(afterDelete.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("leaves adapter-sourced foods shared, because they always were", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);

    await app.inject({
      method: "GET",
      url: "/api/food/barcode/7310865004703",
      headers: auth(alice),
    });

    const asBob = await app.inject({
      method: "GET",
      url: "/api/food/search?q=havregryn",
      headers: auth(bob),
    });
    expect(asBob.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);
  });
});

describe("meal templates", () => {
  async function templateFor(app: FastifyInstance, user: TestUser, itemId: string) {
    return app.inject({
      method: "POST",
      url: "/api/meal-templates",
      headers: auth(user),
      payload: {
        name: "Frukost",
        defaultMealSlot: "breakfast",
        items: [{ foodItemId: itemId, nameSnapshot: "Havregryn", grams: 60 }],
      },
    });
  }

  it("round-trips a template", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(user),
      })
    ).json<{ item: { id: string } }>().item;

    const created = await templateFor(app, user, item.id);
    expect(created.statusCode).toBe(201);
    expect(created.json<{ items: unknown[] }>().items).toHaveLength(1);

    const list = await app.inject({
      method: "GET",
      url: "/api/meal-templates",
      headers: auth(user),
    });
    expect(list.json<{ templates: unknown[] }>().templates).toHaveLength(1);
  });

  it("applies a template as one entry per item, idempotently", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(user),
      })
    ).json<{ item: { id: string } }>().item;
    const template = (await templateFor(app, user, item.id)).json<{ id: string }>();

    const uuids = [randomUUID()];
    const payload = { localDate: localDate(), clientUuids: uuids };

    const first = await app.inject({
      method: "POST",
      url: `/api/meal-templates/${template.id}/apply`,
      headers: auth(user),
      payload,
    });
    await app.inject({
      method: "POST",
      url: `/api/meal-templates/${template.id}/apply`,
      headers: auth(user),
      payload,
    });

    expect(first.json<{ entries: unknown[] }>().entries).toHaveLength(1);

    // Replaying the whole application must not double the meal.
    const entries = await app.inject({
      method: "GET",
      url: "/api/food-entry",
      headers: auth(user),
    });
    expect(entries.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });

  it("refuses an application with the wrong number of ids", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(user),
      })
    ).json<{ item: { id: string } }>().item;
    const template = (await templateFor(app, user, item.id)).json<{ id: string }>();

    const response = await app.inject({
      method: "POST",
      url: `/api/meal-templates/${template.id}/apply`,
      headers: auth(user),
      payload: { localDate: localDate(), clientUuids: [randomUUID(), randomUUID()] },
    });

    expect(response.statusCode).toBe(400);
  });

  /** D17: a deleted food must leave a readable line, not grams of nothing. */
  it("keeps a readable name after the food it points at is deleted", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(user),
      })
    ).json<{ item: { id: string } }>().item;
    const template = (await templateFor(app, user, item.id)).json<{ id: string }>();

    await db.delete(foodItems).where(eq(foodItems.id, item.id));

    const [row] = await db.select().from(mealTemplateItems);
    expect(row?.foodItemId).toBeNull();
    // Not grams of nothing.
    expect(row?.nameSnapshot).toBe("Havregryn");

    const fetched = await app.inject({
      method: "GET",
      url: `/api/meal-templates/${template.id}`,
      headers: auth(user),
    });
    expect(fetched.json<{ items: { nameSnapshot: string }[] }>().items[0]!.nameSnapshot).toBe(
      "Havregryn",
    );
  });

  it("keeps one user's templates out of another's", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);
    const item = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(bob),
      })
    ).json<{ item: { id: string } }>().item;
    const template = (await templateFor(app, bob, item.id)).json<{ id: string }>();

    const list = await app.inject({
      method: "GET",
      url: "/api/meal-templates",
      headers: auth(alice),
    });
    expect(list.json<{ templates: unknown[] }>().templates).toEqual([]);

    const direct = await app.inject({
      method: "GET",
      url: `/api/meal-templates/${template.id}`,
      headers: auth(alice),
    });
    expect(direct.statusCode).toBe(404);
  });
});

describe("recent foods", () => {
  it("lists distinct foods, most recent first", async () => {
    current = fakeAdapter({ barcodes: { "7310865004703": havregryn } });
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const item = (
      await app.inject({
        method: "GET",
        url: "/api/food/barcode/7310865004703",
        headers: auth(user),
      })
    ).json<{ item: { id: string } }>().item;

    // The same food twice, plus a freetext one.
    for (const grams of [50, 60]) {
      await app.inject({
        method: "POST",
        url: "/api/food-entry",
        headers: auth(user),
        payload: { clientUuid: randomUUID(), localDate: localDate(), foodItemId: item.id, grams },
      });
    }
    await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        freetext: "kaffe",
        grams: 200,
        kcal: 5,
      },
    });

    const recent = await app.inject({
      method: "GET",
      url: "/api/food-entry/recent",
      headers: auth(user),
    });
    const entries = recent.json<{ entries: { name: string }[] }>().entries;

    // Two distinct foods, not three entries.
    expect(entries).toHaveLength(2);
    expect(entries[0]!.name).toBe("kaffe");
  });
});
