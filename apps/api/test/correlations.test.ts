import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

const ctx = useTestApp();

type Pane = {
  pane: string;
  pairs: { localDate: string; x: number; y: number }[];
  sampleSize: number;
  unpairedDays: number;
  range: { from: string; to: string } | null;
  enough: boolean;
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
      expect(Object.keys(pane).sort()).toEqual([
        "enough",
        "pairs",
        "pane",
        "range",
        "sampleSize",
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
