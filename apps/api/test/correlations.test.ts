import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { expectedChangeKgPerWeek, KCAL_PER_KG } from "shared";
import { auth, createUser, localDate, type TestUser } from "./factories.js";
import { useTestApp } from "./harness.js";
import type { Db } from "../src/db/index.js";
import { manualIntake, weightLog } from "../src/db/schema.js";

const ctx = useTestApp();

type Pane = {
  pane: string;
  /** `transitional` is the weekly pane's ring flag (D170); daily panes have none. */
  pairs: { localDate: string; x: number; y: number; transitional?: boolean }[];
  sampleSize: number;
  unpairedDays: number;
  range: { from: string; to: string } | null;
  enough: boolean;
  unit: "day" | "week";
  needed: number;
  lagDays: number | null;
  reference: { maintenanceKcal: number; kcalPerKg: number } | null;
};

const paneNamed = (body: { panes: Pane[] }, name: string) =>
  body.panes.find((pane) => pane.pane === name)!;

describe("GET /api/correlations", () => {
  it("pairs sleep against energy on the days that have both", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (let day = 4; day >= 0; day--) {
      await app.inject({
        method: "POST",
        url: "/api/daily",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: localDate(-day),
          sleepHours: 7 + day * 0.25,
          energy: 3,
        },
      });
    }

    const response = await app.inject({
      method: "GET",
      url: "/api/correlations",
      headers: auth(user),
    });

    const pane = paneNamed(response.json<{ panes: Pane[] }>(), "sleep_energy");
    expect(pane.sampleSize).toBe(5);
    expect(pane.pairs).toHaveLength(5);
    expect(pane.range).toEqual({ from: localDate(-4), to: localDate() });
  });

  /**
   * The mistake that does not throw: filling a missing rating with zero puts a
   * column of points at one end of the axis that reads as a pattern.
   */
  it("drops a half-logged day instead of scoring it zero", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(-1), sleepHours: 7 },
    });
    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), sleepHours: 8, energy: 4 },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/correlations",
      headers: auth(user),
    });

    const pane = paneNamed(response.json<{ panes: Pane[] }>(), "sleep_energy");
    expect(pane.sampleSize).toBe(1);
    expect(pane.unpairedDays).toBe(1);
    expect(pane.pairs.every((pair) => pair.x > 0 && pair.y > 0)).toBe(true);
  });

  it("pairs activity minutes against sweat", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    await app.inject({
      method: "POST",
      url: "/api/activity",
      headers: auth(user),
      payload: {
        clientUuid: randomUUID(),
        localDate: day,
        activityType: "run",
        durationMin: 45,
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, sweat: 4 },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/correlations",
      headers: auth(user),
    });

    const pane = paneNamed(response.json<{ panes: Pane[] }>(), "activity_sweat");
    expect(pane.pairs).toEqual([{ localDate: day, x: 45, y: 4 }]);
  });

  it("sums a day's sessions into one point", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const day = localDate();

    for (const durationMin of [30, 45]) {
      await app.inject({
        method: "POST",
        url: "/api/activity",
        headers: auth(user),
        payload: {
          clientUuid: randomUUID(),
          localDate: day,
          activityType: "walk",
          durationMin,
        },
      });
    }
    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: day, sweat: 3 },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/correlations",
      headers: auth(user),
    });

    expect(paneNamed(response.json<{ panes: Pane[] }>(), "activity_sweat").pairs).toEqual([
      { localDate: day, x: 75, y: 3 },
    ]);
  });

  it("says it has too little rather than plotting four points", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), sleepHours: 7, energy: 3 },
    });

    const body = (
      await app.inject({ method: "GET", url: "/api/correlations", headers: auth(user) })
    ).json<{ panes: Pane[]; minPairs: number; dailyLogDays: number }>();

    expect(paneNamed(body, "sleep_energy").enough).toBe(false);
    expect(body.minPairs).toBeGreaterThan(1);
    expect(body.dailyLogDays).toBe(1);
  });

  it("keeps one user's days out of another's", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    await app.inject({
      method: "POST",
      url: "/api/daily",
      headers: auth(mine),
      payload: { clientUuid: randomUUID(), localDate: localDate(), sleepHours: 7, energy: 3 },
    });

    const body = (
      await app.inject({ method: "GET", url: "/api/correlations", headers: auth(theirs) })
    ).json<{ panes: Pane[] }>();

    expect(paneNamed(body, "sleep_energy").sampleSize).toBe(0);
  });
});

/**
 * D34, held at the API boundary.
 *
 * The decision is that this view shows data, sample size and date range and
 * computes no statistic. A later change that adds an `r` has to break this test
 * to ship, which is the moment the decision should be reopened on purpose
 * rather than drifted past.
 */
describe("the response carries no statistic", () => {
  it("exposes only the points, the count, the unpaired days and the range", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const body = (
      await app.inject({ method: "GET", url: "/api/correlations", headers: auth(user) })
    ).json<{ panes: Pane[] }>();

    for (const pane of body.panes) {
      // D166 added what one point is, how many are needed, the lag the weekly
      // change was shifted by, and the expected line's two inputs. Still no
      // field computed from the points.
      expect(Object.keys(pane).sort()).toEqual([
        "enough",
        "lagDays",
        "needed",
        "pairs",
        "pane",
        "range",
        "reference",
        "sampleSize",
        "unit",
        "unpairedDays",
      ]);
    }
  });

  it("has no field named after a coefficient, a fit or a verdict", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const raw = (
      await app.inject({ method: "GET", url: "/api/correlations", headers: auth(user) })
    ).body.toLowerCase();

    for (const banned of ["\"r\"", "rsquared", "pearson", "slope", "trendline", "pvalue"]) {
      expect(raw).not.toContain(banned);
    }
  });
});

/**
 * Intake against trend change, per whole week (D166).
 *
 * Rows go straight into the open transaction, as in `coach-sheet.test.ts`: ten
 * weeks of daily weights and intake through `inject` would recompute the trend
 * on every write, and nothing under test is on the write path.
 */
describe("intake against trend change", () => {
  const MAINTENANCE = 2500;
  const INTAKE = 2000;

  /**
   * A body that obeys 7700 kcal per kg: `days` of daily weights, each the
   * previous plus the day's deficit, and intake logged on every day. Intake is
   * constant, so every week after burn-in is settled.
   */
  async function obeyingBody(db: Db, user: TestUser, days: number): Promise<void> {
    const weights: { day: string; kg: number }[] = [];
    let kg = 95;
    for (let back = days - 1; back >= 0; back -= 1) {
      weights.push({ day: localDate(-back), kg });
      kg += (INTAKE - MAINTENANCE) / KCAL_PER_KG;
    }

    await db.insert(weightLog).values(
      weights.map(({ day, kg: value }) => ({
        userId: user.userId,
        clientUuid: randomUUID(),
        localDate: day,
        weightKg: value.toFixed(2),
      })),
    );
    await db.insert(manualIntake).values(
      weights.map(({ day }) => ({
        userId: user.userId,
        clientUuid: randomUUID(),
        localDate: day,
        kcal: INTAKE,
      })),
    );
  }

  async function intakePane(app: FastifyInstance, user: TestUser) {
    const body = (
      await app.inject({ method: "GET", url: "/api/correlations", headers: auth(user) })
    ).json<{ panes: Pane[] }>();
    return paneNamed(body, "intake_trend_change");
  }

  /**
   * The ring flag reaches the browser (D170).
   *
   * The pane-level key check above cannot see this: it is a field on each pair.
   * A body whose intake never moves has no transitional week at all, which is
   * the half worth asserting on the wire — a flag that arrived as `true`
   * everywhere would draw every point as a ring and nothing would fail.
   */
  it("marks no week as transitional where intake never changed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await obeyingBody(db, user, 84);

    const pane = await intakePane(app, user);
    expect(pane.pairs.length).toBeGreaterThan(4);
    for (const pair of pane.pairs) {
      expect(pair.transitional, `week of ${pair.localDate}`).toBe(false);
    }
  });

  it("counts whole weeks, and says not yet below four", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await obeyingBody(db, user, 20);

    const pane = await intakePane(app, user);
    expect(pane.unit).toBe("week");
    expect(pane.needed).toBe(4);
    expect(pane.sampleSize).toBeLessThan(4);
    expect(pane.enough).toBe(false);
  });

  it("draws no expected line until maintenance is measured", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await obeyingBody(db, user, 10);

    expect((await intakePane(app, user)).reference).toBeNull();
  });

  it("puts one point per Monday, and settled weeks on the expected line from measured maintenance", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await obeyingBody(db, user, 84);

    const pane = await intakePane(app, user);
    expect(pane.enough).toBe(true);
    expect(pane.lagDays).toBe(9);
    expect(pane.reference).not.toBeNull();
    // Measured from the same body, so it is the body's own maintenance.
    expect(Math.abs(pane.reference!.maintenanceKcal - MAINTENANCE)).toBeLessThan(60);

    for (const pair of pane.pairs) {
      expect(new Date(`${pair.localDate}T12:00:00Z`).getUTCDay()).toBe(1);
    }

    // The last weeks are long past burn-in and intake never changed.
    for (const pair of pane.pairs.slice(-3)) {
      const expected = expectedChangeKgPerWeek(pair.x, pane.reference!.maintenanceKcal);
      expect(Math.abs(pair.y - expected), `week of ${pair.localDate}`).toBeLessThan(0.08);
    }
    // Whole weeks only: the last one ended before today.
    expect(pane.range!.to < localDate()).toBe(true);
  });
});
