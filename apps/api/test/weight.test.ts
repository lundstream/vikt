import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

describe("POST /api/weight — idempotent writes (CLAUDE.md §3)", () => {
  it("posting the same client_uuid twice produces exactly one row", async () => {
    const { app } = ctx();
    const user = await createUser(app, ctx().db);
    const clientUuid = randomUUID();

    const payload = { clientUuid, localDate: localDate(), weightKg: 82.4 };

    const first = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The same row, not a second one.
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);

    const list = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });

  it("a replay with a changed value updates the row rather than adding one", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const clientUuid = randomUUID();
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid, localDate: day, weightKg: 82.4 },
    });
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid, localDate: day, weightKg: 81.9 },
    });

    const list = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
    const entries = list.json<{ entries: { weightKg: number }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.weightKg).toBe(81.9);
  });

  it("a second reading on the same day replaces the first, one canonical row per day", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 82.4 },
    });
    // A different client_uuid — a fresh entry from another device, say.
    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, weightKg: 82.0 },
    });

    const list = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
    const entries = list.json<{ entries: { weightKg: number }[] }>().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.weightKg).toBe(82);
  });

  it("stores the local_date the client sent, without recomputing it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    // A late-evening reading in Stockholm: the UTC instant is the next day, and
    // the server must not "correct" it (CLAUDE.md §3).
    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: "2026-03-14",
        loggedAt: "2026-03-14T23:40:00+01:00",
        weightKg: 82.4,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ localDate: string }>().localDate).toBe("2026-03-14");
  });
});

describe("POST /api/manual-intake", () => {
  it("is idempotent on the same client_uuid", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const payload = { clientUuid: randomUUID(), localDate: localDate(), kcal: 2100 };

    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload,
    });
    await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload,
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/manual-intake",
      headers: auth(user),
    });
    expect(list.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });
});

describe("GET /api/weight — range", () => {
  it("filters inclusively on from and to", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const offset of [-4, -3, -2, -1, 0]) {
      await app.inject({
        method: "POST",
        url: "/api/weight",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(offset),
          weightKg: 80 + offset,
        },
      });
    }

    const response = await app.inject({
      method: "GET",
      url: `/api/weight?from=${localDate(-3)}&to=${localDate(-1)}`,
      headers: auth(user),
    });

    const entries = response.json<{ entries: { localDate: string }[] }>().entries;
    expect(entries.map((e) => e.localDate)).toEqual([
      localDate(-3),
      localDate(-2),
      localDate(-1),
    ]);
  });

  it("comes back in ascending date order regardless of insertion order", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const offset of [0, -5, -2]) {
      await app.inject({
        method: "POST",
        url: "/api/weight",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(offset),
          weightKg: 80,
        },
      });
    }

    const response = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
    const dates = response.json<{ entries: { localDate: string }[] }>().entries.map((e) => e.localDate);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("reading source", () => {
  it("defaults to manual", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 82.4 },
    });

    expect(response.json<{ source: string }>().source).toBe("manual");
  });

  it("round-trips an imported reading, so backfill stays visible as backfill", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(-1),
        weightKg: 82.4,
        source: "import",
      },
    });

    const list = await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) });
    expect(list.json<{ entries: { source: string }[] }>().entries[0]!.source).toBe("import");
  });

  it("refuses a source outside the enum", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        weightKg: 82.4,
        source: "made-up",
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
