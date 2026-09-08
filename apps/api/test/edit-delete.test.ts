import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

/**
 * Editing and deleting log rows.
 *
 * The property that makes deletion safe to offer inline is that **nothing
 * derived is stored**: the trend, the projections, maintenance and the day's
 * intake are all computed from the rows on every read. So a delete is a delete,
 * not a delete plus a repair, and the test for that is the one below: a series
 * with a reading removed must be indistinguishable from a series that never had
 * it.
 */

const logWeightAt = (
  app: FastifyInstance,
  user: TestUser,
  weightKg: number,
  offset: number,
) =>
  app.inject({
    method: "POST",
    url: "/api/weight",
    headers: auth(user),
    payload: { clientUuid: randomUUID(), localDate: localDate(offset), weightKg },
  });

const trendFor = async (app: FastifyInstance, user: TestUser) =>
  (
    await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
  ).json<{ trendWeightKg: number | null; maintenance: { tdee: number | null } }>();

describe("deleting a weight reading", () => {
  /**
   * The assertion the whole feature rests on. Two accounts, one with a reading
   * in the middle that is then removed, one that never had it: the smoothed
   * series must agree to the last decimal.
   *
   * Comparing against a *recomputed* series rather than a stored expectation is
   * deliberate. A hand-written expected number would be computed with the same
   * assumption the code makes, and would agree with a stale cache too.
   */
  it("leaves the same trend as a series that never had it", async () => {
    const { app, db } = ctx();
    const withDeletion = await createUser(app, db);
    const without = await createUser(app, db);

    const series = [88.0, 87.6, 87.9, 87.4, 87.1, 86.8, 86.9, 86.5];
    const removedIndex = 3;

    for (const [index, weight] of series.entries()) {
      const offset = -(series.length - 1 - index);
      await logWeightAt(app, withDeletion, weight, offset);
      if (index !== removedIndex) await logWeightAt(app, without, weight, offset);
    }

    const doomed = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(withDeletion) })
    ).json<{ entries: { id: string; localDate: string }[] }>().entries[removedIndex]!;

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/weight/${doomed.id}`,
      headers: auth(withDeletion),
    });
    expect(deletion.statusCode).toBe(204);

    const after = await trendFor(app, withDeletion);
    const never = await trendFor(app, without);

    expect(after.trendWeightKg).toBeCloseTo(never.trendWeightKg!, 10);
  });

  it("removes the row from the list", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeightAt(app, user, 88, -1);
    await logWeightAt(app, user, 87.5, 0);

    const first = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { id: string }[] }>().entries[0]!;

    await app.inject({
      method: "DELETE",
      url: `/api/weight/${first.id}`,
      headers: auth(user),
    });

    const remaining = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: unknown[] }>().entries;
    expect(remaining).toHaveLength(1);
  });

  /** Deleting the last reading leaves no trend, rather than a stale one. */
  it("leaves no trend when the last reading goes", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeightAt(app, user, 88, 0);

    const only = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { id: string }[] }>().entries[0]!;

    await app.inject({
      method: "DELETE",
      url: `/api/weight/${only.id}`,
      headers: auth(user),
    });

    expect((await trendFor(app, user)).trendWeightKg).toBeNull();
  });

  /**
   * An achieved milestone is not revoked (D8). It happened; deleting the
   * reading that triggered it does not un-happen the day it was reached, and
   * taking one back is the "you ruined it" state §3 forbids.
   */
  it("does not revoke an achieved milestone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/milestones",
      headers: auth(user),
      payload: { label: "Under 100", metric: "weight_kg", targetValue: 100 },
    });
    for (let day = 40; day >= 0; day--) {
      await logWeightAt(app, user, 104 - (40 - day) * 0.2, -day);
    }

    const before = (
      await app.inject({ method: "GET", url: "/api/progress", headers: auth(user) })
    ).json<{ milestones: { achievedAt: string | null }[] }>();
    expect(before.milestones[0]!.achievedAt).not.toBeNull();

    const entries = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { id: string }[] }>().entries;

    await app.inject({
      method: "DELETE",
      url: `/api/weight/${entries.at(-1)!.id}`,
      headers: auth(user),
    });

    const after = (
      await app.inject({ method: "GET", url: "/api/progress", headers: auth(user) })
    ).json<{ milestones: { achievedAt: string | null }[] }>();
    expect(after.milestones[0]!.achievedAt).toBe(before.milestones[0]!.achievedAt);
  });

  it("cannot delete another user's reading", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    await logWeightAt(app, mine, 88, 0);

    const row = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(mine) })
    ).json<{ entries: { id: string }[] }>().entries[0]!;

    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/weight/${row.id}`,
      headers: auth(theirs),
    });

    expect(attempt.statusCode).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/weight", headers: auth(mine) })).json<{
        entries: unknown[];
      }>().entries,
    ).toHaveLength(1);
  });

  it("answers 404 for a reading that is already gone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/weight/${randomUUID()}`,
      headers: auth(user),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("editing a weight reading", () => {
  /**
   * Editing is the same POST as logging: `(user_id, local_date)` holds one
   * canonical reading per day, so re-posting the day replaces it. There is no
   * separate PATCH to keep in step with the write path.
   */
  it("replaces the day's reading and moves the trend", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await logWeightAt(app, user, 88, -1);
    await logWeightAt(app, user, 87.5, 0);
    const before = (await trendFor(app, user)).trendWeightKg!;

    await logWeightAt(app, user, 85.0, 0);

    const entries = (
      await app.inject({ method: "GET", url: "/api/weight", headers: auth(user) })
    ).json<{ entries: { weightKg: number }[] }>().entries;

    expect(entries).toHaveLength(2);
    expect(entries.at(-1)!.weightKg).toBe(85);
    expect((await trendFor(app, user)).trendWeightKg).toBeLessThan(before);
  });
});

describe("deleting a daily log", () => {
  it("makes the day unlogged rather than zeroed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const created = await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        energy: 4,
        alcoholUnits: 0,
      },
    });
    const id = created.json<{ id: string }>().id;

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/daily/${id}`,
      headers: auth(user),
    });
    expect(deletion.statusCode).toBe(204);

    const day = (
      await app.inject({
        method: "GET",
        url: `/api/day?localDate=${localDate()}`,
        headers: auth(user),
      })
    ).json<{ daily: unknown | null }>();
    expect(day.daily).toBeNull();

    // And the sober counter no longer has a dry day to count.
    const sober = (
      await app.inject({ method: "GET", url: "/api/progress", headers: auth(user) })
    ).json<{ sober: { basis: string } }>().sober;
    expect(sober.basis).toBe("no_data");
  });

  it("cannot delete another user's day", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    const created = await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(mine),
      payload: { clientUuid: randomUUID(), localDate: localDate(), energy: 4 },
    });

    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/daily/${created.json<{ id: string }>().id}`,
      headers: auth(theirs),
    });
    expect(attempt.statusCode).toBe(404);
  });
});

describe("deleting a food entry", () => {
  async function logFood(app: FastifyInstance, user: TestUser, kcal: number) {
    const item = await app.inject({
      method: "POST",
      url: "/api/food/manual",
      headers: auth(user),
      payload: { name: "Testmat", kcalPer100: 100 },
    });
    const entry = await app.inject({
      method: "POST",
      url: "/api/food-entry",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: localDate(),
        foodItemId: item.json<{ id: string }>().id,
        grams: kcal,
        mealSlot: "lunch",
      },
    });
    return entry.json<{ id: string }>().id;
  }

  const intakeToday = async (app: FastifyInstance, user: TestUser) =>
    (
      await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
    ).json<{ todayIntakeKcal: number | null }>().todayIntakeKcal;

  it("changes the day's total, because the total is a sum over what remains", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const first = await logFood(app, user, 300);
    await logFood(app, user, 450);
    expect(await intakeToday(app, user)).toBe(750);

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/food-entry/${first}`,
      headers: auth(user),
    });
    expect(deletion.statusCode).toBe(204);

    expect(await intakeToday(app, user)).toBe(450);
  });

  it("leaves the day unlogged when the last entry goes", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const only = await logFood(app, user, 300);

    await app.inject({
      method: "DELETE",
      url: `/api/food-entry/${only}`,
      headers: auth(user),
    });

    expect(await intakeToday(app, user)).toBeNull();
  });

  it("cannot delete another user's entry", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);
    const id = await logFood(app, mine, 300);

    const attempt = await app.inject({
      method: "DELETE",
      url: `/api/food-entry/${id}`,
      headers: auth(theirs),
    });

    expect(attempt.statusCode).toBe(404);
    expect(await intakeToday(app, mine)).toBe(300);
  });
});
