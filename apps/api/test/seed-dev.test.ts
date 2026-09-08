import { describe, expect, it } from "vitest";
import { assertDevOnly, SEED_EMAIL, SeedRefused } from "../src/scripts/seed-dev.js";

/**
 * The dev seed plants a known email with a password written down in the source.
 * Running it anywhere but development would create a working account anyone who
 * has read the repo can sign in to, so the guard is worth its own tests.
 */
describe("the dev seed refuses to run outside development", () => {
  const devUrl = "postgres://vikt:pw@localhost:5432/vikt";

  it("runs when NODE_ENV is development", () => {
    expect(() =>
      assertDevOnly({ NODE_ENV: "development", SEED_PASSWORD: "a-dev-password", DATABASE_URL: devUrl }),
    ).not.toThrow();
  });

  it("refuses in production", () => {
    expect(() => assertDevOnly({ NODE_ENV: "production", DATABASE_URL: devUrl })).toThrow(
      SeedRefused,
    );
  });

  it("refuses when NODE_ENV is unset, rather than assuming development", () => {
    expect(() => assertDevOnly({ DATABASE_URL: devUrl })).toThrow(SeedRefused);
  });

  it("refuses for any other NODE_ENV, including typos", () => {
    for (const nodeEnv of ["prod", "staging", "developmnet", "Development", ""]) {
      expect(() => assertDevOnly({ NODE_ENV: nodeEnv, DATABASE_URL: devUrl })).toThrow(
        SeedRefused,
      );
    }
  });

  it("refuses a development NODE_ENV pointed at a production-looking database", () => {
    expect(() =>
      assertDevOnly({
        NODE_ENV: "development", SEED_PASSWORD: "a-dev-password",
        DATABASE_URL: "postgres://vikt:pw@db.example.internal:5432/vikt_prod",
      }),
    ).toThrow(SeedRefused);
  });

  it("allows the development and test databases", () => {
    for (const name of ["vikt", "vikt_dev", "vikt_test", "something_development"]) {
      expect(() =>
        assertDevOnly({
          NODE_ENV: "development", SEED_PASSWORD: "a-dev-password",
          DATABASE_URL: `postgres://vikt:pw@localhost:5432/${name}`,
        }),
      ).not.toThrow();
    }
  });

  it("refuses when DATABASE_URL is missing or unparseable", () => {
    expect(() => assertDevOnly({ NODE_ENV: "development" })).toThrow(SeedRefused);
    expect(() =>
      assertDevOnly({ NODE_ENV: "development", SEED_PASSWORD: "a-dev-password", DATABASE_URL: "not a url" }),
    ).toThrow(SeedRefused);
  });

  it("says why, and names the account it would have created", () => {
    try {
      assertDevOnly({ NODE_ENV: "production", DATABASE_URL: devUrl });
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as Error).message).toContain("production");
      expect((error as Error).message).toContain(SEED_EMAIL);
    }
  });
});

/**
 * The password moved out of the source (D87), and the seeder refuses without
 * one rather than falling back to a default.
 *
 * A default would be the same published password this change removed, only
 * one indirection further away.
 */
it("refuses when no seed password is configured", () => {
  expect(() =>
    assertDevOnly({
      NODE_ENV: "development",
      DATABASE_URL: "postgres://vikt:pw@localhost:5432/vikt",
    } as NodeJS.ProcessEnv),
  ).toThrow(/SEED_PASSWORD/);
});
