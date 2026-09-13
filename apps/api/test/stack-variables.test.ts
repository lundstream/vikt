import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envSchema } from "../src/env.js";

/**
 * Every variable the API reads reaches the container (D147).
 *
 * A stack variable set in Portainer that the compose file does not forward is
 * **silently absent**. Not a boot failure, not a warning: the schema's default
 * takes over and the feature is simply off, while the panel the operator is
 * looking at shows the value they typed. That is the worst shape a deploy
 * failure can take, because every visible signal says it was configured.
 *
 * It had already happened twice before this test existed. D120 found
 * `PUBLIC_BASE_URL` and `SECRET_KEY` missing from `docker-compose.yml` and
 * fixed them there; nothing checked the Portainer file, which is the one
 * production actually runs, and it was missing seventeen.
 *
 * So the schema is the source of truth and the two files are checked against
 * it. A variable added to `env.ts` now fails here until it is both forwarded
 * and documented, which is the only ordering that cannot be forgotten.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const COMPOSE = path.join(ROOT, "infra/docker-compose.portainer.yml");
const EXAMPLE = path.join(ROOT, "infra/.env.example");

/**
 * Variables the compose deliberately does not forward, each with the reason.
 *
 * Deliberately tiny and deliberately explicit. An allowlist is how a check like
 * this rots: the answer to a failure here is almost always to forward the
 * variable, and the entries below are the cases where it is not.
 */
const NOT_IN_COMPOSE: Record<string, string> = {
  /**
   * The former name for `PUBLIC_BASE_URL`, kept only so an existing deployment
   * does not lose its links on upgrade (D109). Forwarding it would offer two
   * variables that mean one thing, which is the defect that entry is about.
   */
  PUBLIC_ORIGIN: "deprecated alias for PUBLIC_BASE_URL (D109); the boot log says to move off it",
};

/** The same, for the documentation. Empty: every variable is worth describing. */
const NOT_IN_EXAMPLE: Record<string, string> = {};

const variables = Object.keys(envSchema.shape).sort();

/**
 * The names the compose hands the **api** service.
 *
 * Read out of the file rather than out of a parsed YAML tree, because what
 * matters is the text an operator reads and edits, and a YAML library would
 * happily accept a key nested under the wrong service.
 */
function serviceEnvironment(service: string): Set<string> {
  const text = readFileSync(COMPOSE, "utf8");
  const start = text.indexOf(`\n  ${service}:`);
  expect(start, `the compose has no ${service} service`).toBeGreaterThan(-1);

  // Up to the next top-level service, which is two-space indented like `api:`.
  const rest = text.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  const block = end === -1 ? rest : rest.slice(0, end);

  const envStart = block.indexOf("\n    environment:");
  expect(envStart, `the ${service} service has no environment block`).toBeGreaterThan(-1);

  const names = new Set<string>();
  for (const line of block.slice(envStart).split("\n")) {
    // Six spaces is one level inside `environment:`; anything shallower ends it.
    const match = line.match(/^ {6}([A-Z][A-Z0-9_]*):/);
    if (match?.[1]) names.add(match[1]);
    else if (/^ {4}\S/.test(line) && !line.includes("environment:")) break;
  }
  return names;
}

/**
 * What the API reads at boot without declaring in `envSchema` (D157).
 *
 * `assertProdSecrets` reads `CONTACT_EMAIL` straight off `process.env` and
 * refuses to start without it whenever `LANDING_ENABLED` or `REQUEST_ENABLED`
 * is true. The main loop below walks the schema, so it cannot see this one, and
 * the cost of missing it is the API not starting.
 *
 * It is also what makes the negative control below correct: a variable in the
 * nginx block is nginx's alone **unless** it is in the schema or on this list.
 */
const READ_OUTSIDE_SCHEMA = ["CONTACT_EMAIL"];

/**
 * Variables that reach nginx and nothing on the server reads.
 *
 * **Derived, never chosen** (D157). This is the negative control that proves
 * `serviceEnvironment` returns one service's block rather than every name in
 * the file, and the previous version of it named `CONTACT_EMAIL` by hand — a
 * variable the API needs, which made the guard assert the defect and took
 * production down when the fix finally contradicted it.
 *
 * Computing the control removes the hand that picked wrong. Anything nginx is
 * given that the schema does not declare and that is not on the short list
 * above belongs to nginx, and no future edit can pick the wrong one.
 */
function nginxOnly(): string[] {
  const schema = new Set(Object.keys(envSchema.shape));
  const alsoTheApi = new Set(READ_OUTSIDE_SCHEMA);

  return [...serviceEnvironment("nginx")].filter(
    (name) => !schema.has(name) && !alsoTheApi.has(name),
  );
}

/** Every `NAME=` the example file defines, commented-out ones included. */
function documented(): Set<string> {
  const names = new Set<string>();
  for (const line of readFileSync(EXAMPLE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

describe("the schema itself", () => {
  /** A check that reads nothing finds nothing. */
  it("has variables to check", () => {
    expect(variables.length).toBeGreaterThan(25);
    expect(variables).toContain("DATABASE_URL");
    expect(variables).toContain("VAPID_PUBLIC_KEY");
  });
});

describe("infra/docker-compose.portainer.yml", () => {
  const forwarded = serviceEnvironment("api");

  /** The parser, shown working, before anything is asserted with it. */
  it("is read correctly enough to be worth asserting on", () => {
    expect(forwarded.has("DATABASE_URL")).toBe(true);
    expect(forwarded.has("SESSION_SECRET")).toBe(true);
  });

  /**
   * The negative control, computed rather than named (D157).
   *
   * Without one, a parser that returned every variable in the file would
   * satisfy every other assertion here. With one chosen by hand, the hand can
   * choose a variable the API needs — which is what happened, and what the
   * guard then asserted for as long as it was wrong.
   */
  it("returns one service's block, not every name in the file", () => {
    const control = nginxOnly();

    expect(
      control.length,
      "no nginx-only variable left to use as a control; the assertion below proves nothing",
    ).toBeGreaterThan(0);

    for (const name of control) {
      expect(
        forwarded.has(name),
        `${name} reaches nginx and is not in the schema, so it should not be in the api block`,
      ).toBe(false);
    }
  });

  /**
   * `CONTACT_EMAIL` is read by **both** services, and this test is the reason
   * to say so out loud (D157).
   *
   * nginx substitutes it into the built page (D121). The API reads it at boot
   * in `assertProdSecrets` and **refuses to start** without it whenever
   * `LANDING_ENABLED` or `REQUEST_ENABLED` is true. It is not in `envSchema`,
   * so the loop below never covered it, and this file previously asserted the
   * opposite of what the API needs: that the api service does *not* get it.
   *
   * That assertion was green for as long as it was wrong, and it took
   * production down on the 1.1.0 deploy: the API crash-looped on a variable
   * that was set in Portainer, spelled correctly, and visible in the panel.
   *
   * A test can only pin the behaviour somebody believed at the time. This one
   * is written from the failure instead.
   */
  it("forwards CONTACT_EMAIL to the API, which refuses to boot without it", () => {
    expect(forwarded.has("CONTACT_EMAIL")).toBe(true);
  });

  /**
   * Everything the API reads at boot but does not declare in `envSchema`.
   *
   * The loop below walks the schema, so anything read straight off
   * `process.env` is invisible to it. That is a small list and it is written
   * here rather than inferred, because the cost of missing one is the API not
   * starting.
   */
  it("forwards what the API reads outside the schema", () => {
    for (const name of READ_OUTSIDE_SCHEMA) {
      expect(forwarded.has(name), `${name} never reaches the api service`).toBe(true);
      expect(documented().has(name), `${name} is not in .env.example`).toBe(true);
    }
  });

  it.each(variables)("forwards %s to the api container", (name) => {
    if (NOT_IN_COMPOSE[name]) {
      expect(forwarded.has(name), `${name} is allowlisted but forwarded anyway`).toBe(false);
      return;
    }

    expect(
      forwarded.has(name),
      `${name} is in the API's env schema and the Portainer compose does not pass it. ` +
        "A value set in the stack panel would be silently absent in the container.",
    ).toBe(true);
  });
});

/**
 * The default written into the compose, where it writes one.
 *
 * `${NAME:-value}` is a second copy of a default the schema already holds, and
 * it has to be a copy rather than a reference because compose has no way to ask
 * the program. A copy that drifts is worse than no copy: the file says 20000,
 * the schema says 30000, and which one is in force depends on whether anybody
 * set the variable.
 */
function composeDefaults(): Map<string, string> {
  const text = readFileSync(COMPOSE, "utf8");
  const defaults = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^ {6}([A-Z][A-Z0-9_]*): \$\{([A-Z][A-Z0-9_]*):-(.*)\}$/);
    if (match?.[1] && match[1] === match[2]) defaults.set(match[1], match[3] ?? "");
  }
  return defaults;
}

/** The schema's own default, as the string an environment would carry. */
function schemaDefault(name: string): string | null {
  const field = envSchema.shape[name as keyof typeof envSchema.shape] as
    | { _def?: { defaultValue?: () => unknown } }
    | undefined;

  const value = field?._def?.defaultValue?.();
  if (value === undefined) return null;
  return typeof value === "boolean" ? String(value) : String(value);
}

describe("the images the stack pulls", () => {
  /**
   * `.+` rather than `\S+`: a pinned image now carries
   * `${IMAGE_TAG:?set IMAGE_TAG, e.g. 1.1.0}`, which has spaces in it. The
   * trailing `\s*` takes the carriage return on a CRLF checkout.
   */
  const images = readFileSync(COMPOSE, "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^ {4}image: (.+?)\s*$/)?.[1])
    .filter((image): image is string => image !== undefined);

  it("found the image lines", () => {
    // Two own images plus the pinned Postgres.
    expect(images).toHaveLength(3);
  });

  /**
   * Matched on the image *name* rather than on the registry literal, because
   * the registry is a variable now (D156): `${IMAGE_REPO:-ghcr.io/lundstream/}`
   * so the same file serves a registry pull and a workstation build that was
   * loaded onto the host. The test that used to look for the literal string
   * would have gone quietly to zero matches and passed nothing.
   */
  const own = images.filter((image) => /vikt-(api|web):/.test(image));

  /**
   * A `latest` fallback means a redeploy pulls whatever `main` happened to be
   * when nobody was looking, and a stack that cannot say which version it runs
   * cannot be rolled back to a known one either (D148).
   */
  it("pins a version rather than latest", () => {
    expect(own).toHaveLength(2);

    for (const image of own) {
      expect(image, `${image} pulls a moving tag`).not.toContain("latest");
      // `:?` rather than `:-`: the stack refuses rather than guessing.
      expect(image, `${image} has a fallback tag`).toContain("${IMAGE_TAG:?");
    }
  });

  /**
   * The registry stays the default, so the ordinary deploy needs no variable
   * set and only a local build has to say so.
   */
  it("defaults to the registry", () => {
    for (const image of own) {
      expect(image, `${image} lost its registry default`).toContain(
        "${IMAGE_REPO:-ghcr.io/lundstream/}",
      );
    }
  });

  /** Both images come from one commit and one workflow. One tag, always. */
  it("moves both images together", () => {
    const tags = own.map((image) => image.replace(/^.*vikt-(?:api|web):/, ""));

    expect(new Set(tags).size).toBe(1);
  });
});

describe("the defaults written twice", () => {
  const defaults = composeDefaults();

  it("found some to compare", () => {
    expect(defaults.size).toBeGreaterThan(10);
  });

  /**
   * Every `${NAME:-value}` in the compose agrees with the schema's default for
   * the same name. The two are the same fact written in two files, and nothing
   * but this reads both.
   */
  it.each([...defaults.keys()].sort())("%s matches the schema's default", (name) => {
    const fromSchema = schemaDefault(name);
    if (fromSchema === null) return;

    expect(
      defaults.get(name),
      `the compose defaults ${name} to ${JSON.stringify(defaults.get(name))} and ` +
        `env.ts defaults it to ${JSON.stringify(fromSchema)}. One of them is wrong, ` +
        "and which one is in force depends on whether the variable happens to be set.",
    ).toBe(fromSchema);
  });
});

describe("infra/.env.example", () => {
  const described = documented();

  it("is read correctly enough to be worth asserting on", () => {
    expect(described.has("DATABASE_URL")).toBe(true);
    expect(described.has("SESSION_SECRET")).toBe(true);
  });

  it.each(variables)("documents %s", (name) => {
    if (NOT_IN_EXAMPLE[name]) return;

    expect(
      described.has(name),
      `${name} is in the API's env schema and infra/.env.example does not mention it. ` +
        "The example file is where an operator finds out a variable exists.",
    ).toBe(true);
  });
});
