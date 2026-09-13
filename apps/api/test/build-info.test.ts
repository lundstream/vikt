import { describe, expect, it } from "vitest";
import { buildInfo } from "../src/lib/build-info.js";
import { useTestApp } from "./harness.js";

/**
 * Which build this is, and whether the config path says so (D151).
 *
 * The version reaches the container as a Docker **build argument**, baked into
 * the image by `release.yml` from the tag and the commit. That is the property
 * worth a test: a version an operator could set would be a version nobody could
 * trust at the moment it matters, and the whole reason to print one is the
 * first question of an incident.
 *
 * `ARG` becomes `ENV` in the runtime stage, so what the test can reach is the
 * environment variable the argument produces. What it holds is that the value
 * put there is the value `/api/health` reports, unchanged, and that a build
 * given nothing says `dev` rather than pretending.
 */

describe("reading the build", () => {
  it("carries the version and commit the build argument set", () => {
    const info = buildInfo({ APP_VERSION: "1.1.0", APP_COMMIT: "a1b2c3d4e5f60718" });

    expect(info.version).toBe("1.1.0");
    expect(info.commit).toBe("a1b2c3d4e5f60718");
    expect(info.shortCommit).toBe("a1b2c3d");
    expect(info.label).toBe("1.1.0 (a1b2c3d)");
  });

  /**
   * A tree that is not a release says so. `dev` is not a version anybody could
   * mistake for one, which is the point: an empty string would read as a
   * rendering fault and a plausible number would be a lie.
   */
  it("says dev when no version was baked in", () => {
    const info = buildInfo({});

    expect(info.version).toBe("dev");
    expect(info.label.startsWith("dev")).toBe(true);
  });

  /** A local `pnpm dev` off a checkout: no tag, but a commit worth printing. */
  it("keeps the commit on a development build", () => {
    expect(buildInfo({ APP_COMMIT: "deadbeefcafe" }).label).toBe("dev (deadbee)");
  });

  /**
   * `ARG APP_COMMIT=` with nothing after it produces an empty string rather
   * than an absent variable, so a blank one falls through to the checkout —
   * which is what makes `pnpm dev` say which commit it is running.
   */
  it("falls back to the checkout when the argument is blank", () => {
    const info = buildInfo({ APP_VERSION: "  ", APP_COMMIT: "  " });

    expect(info.version).toBe("dev");
    // Forty hex characters in a checkout, empty in a container that has no
    // `.git`. Both are correct answers and neither is a guess.
    expect(info.commit === "" || /^[0-9a-f]{40}$/.test(info.commit)).toBe(true);
  });

  /**
   * The baked value wins, always. A built image must say what was put in it
   * even if something has left a `.git` beside it, or the version would stop
   * being a property of the artefact.
   */
  it("prefers the build argument over the checkout", () => {
    expect(buildInfo({ APP_COMMIT: "a1b2c3d4e5f60718" }).shortCommit).toBe("a1b2c3d");
  });
});

describe("the config path the client reads", () => {
  const ctx = useTestApp();

  /**
   * `/api/health` is where the app's footer, Administration and the boot log's
   * own first line all get this, so they cannot disagree about which build is
   * running.
   */
  it("reports what the environment holds", async () => {
    const { app } = ctx();

    const before = process.env.APP_VERSION;
    const beforeCommit = process.env.APP_COMMIT;
    process.env.APP_VERSION = "1.1.0";
    process.env.APP_COMMIT = "a1b2c3d4e5f60718";

    try {
      const response = await app.inject({ method: "GET", url: "/api/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: "ok",
        version: "1.1.0",
        commit: "a1b2c3d4e5f60718",
      });
    } finally {
      if (before === undefined) delete process.env.APP_VERSION;
      else process.env.APP_VERSION = before;
      if (beforeCommit === undefined) delete process.env.APP_COMMIT;
      else process.env.APP_COMMIT = beforeCommit;
    }
  });

  /** Unauthenticated, like the modes beside it: one curl answers the question. */
  it("needs no session", async () => {
    const { app } = ctx();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ version: string }>().version).toBeTypeOf("string");
  });
});
