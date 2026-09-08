import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, createUser, localDate } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * An account created the way a real one now is: no height (D105).
 *
 * Height left the registration form, so this is not an edge case any more, it
 * is the state every new account starts in. Three derived figures read it, and
 * D20's design says each names its absence rather than guessing. That was true
 * of the code before this change and untested in this combination, which is a
 * distinction this project has been caught by twice.
 */

describe("a fresh account, as registration now creates one", () => {
  const ctx = useTestApp();

  it("has no height at all", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db, { heightCm: null });

    const me = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(me.statusCode).toBe(200);
    expect(me.json().profile.heightCm).toBeNull();
  });

  /**
   * The formula names height among what it is missing, so the screen can ask
   * for exactly that and nothing else. A guessed height would produce a
   * maintenance figure indistinguishable from a real one and several hundred
   * kcal wrong, which is the whole of D20.
   */
  it("says which fields the formula is waiting for", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db, { heightCm: null });

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });

    const insights = (
      await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
    ).json();

    expect(insights.maintenance.source).toBe("none");
    expect(insights.maintenance.tdee).toBeNull();
    expect(insights.maintenance.missing).toContain("heightCm");
  });

  /** BMI needs height. Null, not zero, and not a number from a default. */
  it("returns no BMI and no waist-to-height series", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db, { heightCm: null });

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });
    await app.inject({
      method: "POST",
      url: "/api/measurements",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), waistCm: 92 },
    });

    const insights = (
      await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
    ).json();

    expect(insights.bmi).toBeNull();
    expect(insights.whtr).toEqual([]);
  });

  /** Everything that does not need height keeps working, which is the point. */
  it("logs weight and food exactly as any other account does", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db, { heightCm: null });

    const weight = await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88.4 },
    });
    // Weight is one row per day too, upserted, so 200 (§3).
    expect(weight.statusCode).toBe(200);

    // An upsert on the day (§3), so it answers 200 rather than 201.
    const intake = await app.inject({
      method: "POST",
      url: "/api/manual-intake",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), kcal: 2100 },
    });
    expect(intake.statusCode).toBe(200);

    const insights = (
      await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
    ).json();
    expect(insights.todayIntakeKcal).toBe(2100);
  });

  /** And filling it in later works, which is what the welcome card links to. */
  it("computes BMI once the height is filled in", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db, { heightCm: null });

    await app.inject({
      method: "POST",
      url: "/api/weight",
      headers: auth(user),
      payload: { clientUuid: randomUUID(), localDate: localDate(), weightKg: 88 },
    });

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { heightCm: 180 },
    });
    expect(patched.statusCode).toBe(200);

    const insights = (
      await app.inject({ method: "GET", url: "/api/insights", headers: auth(user) })
    ).json();
    expect(insights.bmi).toBeGreaterThan(20);
    expect(insights.maintenance.missing).not.toContain("heightCm");
  });
});

describe("registration", () => {
  const ctx = useTestApp();

  /** The form asks for what creates an account, and height is not that (D105). */
  it("does not ask for a height", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db, { heightCm: null });

    const me = (await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })).json();
    expect(me.profile.heightCm).toBeNull();
    // The account is complete in every other respect.
    expect(me.profile.timezone).toBe("Europe/Stockholm");
    expect(me.email).toBe(user.email);
  });
});
