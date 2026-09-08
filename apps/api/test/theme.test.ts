import { describe, expect, it } from "vitest";
import { auth, createUser } from "./factories.js";
import { useTestApp } from "./harness.js";

/**
 * The theme choice belongs to the account (D117).
 *
 * Three tests, and the first one is the reason the column exists rather than a
 * `localStorage` key: the value has to survive a different browser, which means
 * it has to come back from the server. The other two are the boundary, since an
 * enum written straight into a text column is only an enum if something refuses
 * the fourth value.
 */

describe("the theme setting", () => {
  const ctx = useTestApp();

  /** A new account follows the OS, which is what the app did before there was a choice. */
  it("defaults to system", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(me.json().profile.theme).toBe("system");
  });

  it("round-trips a choice", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { theme: "light" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().profile.theme).toBe("light");

    // And a fresh read sees it, which is the property a device-local setting
    // cannot have: another browser signing in gets the same answer.
    const reread = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(reread.json().profile.theme).toBe("light");
  });

  it("refuses a value that is not one of the three", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { theme: "midnight" },
    });
    expect(response.statusCode).toBe(400);
  });

  /** And it changes nothing else, since a partial PATCH is easy to get wrong. */
  it("leaves the rest of the profile alone", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const before = (
      await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })
    ).json().profile;

    await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { theme: "dark" },
    });

    const after = (
      await app.inject({ method: "GET", url: "/api/me", headers: auth(user) })
    ).json().profile;

    expect({ ...after, theme: before.theme }).toEqual(before);
  });
});
