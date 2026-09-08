import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate, logWeight } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Multi-user isolation — CLAUDE.md §3, "the number one bug class in this kind
 * of app".
 *
 * The failure is silent: an unscoped query returns another user's rows and
 * looks perfectly normal in any test that only ever has one user in the
 * database. So every test here puts *two* users in and checks the boundary
 * between them.
 */
describe("a request scoped to user A cannot read user B's rows", () => {
  it("keeps weight logs apart", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(alice),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 61.5 },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(bob),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 94.2 },
    });

    const asAlice = await app.inject({
      method: "GET",
      url: "/api/weight",
      headers: auth(alice),
    });
    const entries = asAlice.json<{ entries: { weightKg: number }[] }>().entries;

    expect(entries).toHaveLength(1);
    expect(entries[0]!.weightKg).toBe(61.5);
    expect(entries.some((e) => e.weightKg === 94.2)).toBe(false);
  });

  it("keeps manual intake apart", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(bob),
      payload: { clientUuid: randomUUID(), localDate: localDate(), kcal: 3300 },
    });

    const asAlice = await app.inject({
      method: "GET",
      url: "/api/manual-intake",
      headers: auth(alice),
    });
    expect(asAlice.json<{ entries: unknown[] }>().entries).toEqual([]);
  });

  it("keeps plans apart", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);
    await logWeight(app, bob, 95);

    const created = await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(bob),
      payload: {
        name: "Bob's plan",
        startDate: localDate(),
        targetIntakeKcal: 2200,
        intakeFloorKcal: 1500,
      },
    });
    expect(created.statusCode).toBe(201);

    const asAlice = await app.inject({ method: "GET", url: "/api/plans", headers: auth(alice) });
    expect(asAlice.json<{ plans: unknown[] }>().plans).toEqual([]);
  });

  it("will not let A edit B's plan by its id", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);
    await logWeight(app, bob, 95);

    const created = await app.inject({
      method: "POST",
      url: `/api/plans?asOf=${localDate()}`,
      headers: auth(bob),
      payload: {
        name: "Bob's plan",
        startDate: localDate(),
        targetIntakeKcal: 2200,
        intakeFloorKcal: 1500,
      },
    });
    const planId = created.json<{ id: string }>().id;

    // Alice has the id. Knowing a uuid must not be the same as being allowed.
    const attempt = await app.inject({
      method: "PATCH",
      url: `/api/plans/${planId}`,
      headers: auth(alice),
      payload: { name: "Alice was here" },
    });
    expect(attempt.statusCode).toBe(404);

    const stillBobs = await app.inject({ method: "GET", url: "/api/plans", headers: auth(bob) });
    expect(stillBobs.json<{ plans: { name: string }[] }>().plans[0]!.name).toBe("Bob's plan");
  });

  it("returns A's own profile from /api/me, never B's", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db, { heightCm: 161 });
    const bob = await createUser(app, db, { heightCm: 194 });

    const asAlice = await app.inject({ method: "GET", url: "/api/me", headers: auth(alice) });
    const asBob = await app.inject({ method: "GET", url: "/api/me", headers: auth(bob) });

    expect(asAlice.json<{ profile: { heightCm: number } }>().profile.heightCm).toBe(161);
    expect(asBob.json<{ profile: { heightCm: number } }>().profile.heightCm).toBe(194);
    expect(asAlice.json<{ email: string }>().email).toBe(alice.email);
  });

  it("does not let one user's client_uuid collide with another's", async () => {
    const { app, db } = ctx();
    const alice = await createUser(app, db);
    const bob = await createUser(app, db);
    // The uniqueness is per user, so the same uuid from two people is fine.
    const shared = randomUUID();

    const a = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(alice),
      payload: { clientUuid: shared, localDate: localDate(), weightKg: 61.5 },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(bob),
      payload: { clientUuid: shared, localDate: localDate(), weightKg: 94.2 },
    });

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });
});

describe("unauthenticated requests", () => {
  it("are refused on every logging endpoint", async () => {
    const { app } = ctx();
    for (const url of ["/api/weight", "/api/manual-intake", "/api/plans"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});
