import { z } from "zod";
import { isLocalBaseUrl } from "./lib/links.js";

/**
 * Environment and boot-time secret checking.
 *
 * Carried over from FormulaSpun (CLAUDE.md §2): `assertProdSecrets()` runs
 * before anything listens, and **exits the process** if a required secret is
 * missing or still holds its `.env.example` placeholder. Fail closed. Never
 * warn and continue — a warning scrolls past and the box runs for a year with
 * a publicly known session secret.
 */

/**
 * The literal values shipped in `infra/.env.example`. If a running process
 * still has one of these, the operator copied the example file and never
 * edited it. Keep this list in sync with that file.
 */
const EXAMPLE_VALUES: Record<string, readonly string[]> = {
  SMTP_PASS: ["change-me", "your-app-password", "replace-me"],
  SECRET_KEY: ["change-me-to-64-random-hex-characters", "replace-me", "changeme"],
  SESSION_SECRET: [
    "change-me-to-64-random-hex-characters",
    "replace-me",
    "changeme",
  ],
  DATABASE_URL: [
    "postgres://vikt:change-me@localhost:5432/vikt",
    "postgres://user:password@localhost:5432/dbname",
  ],
};

/** Secrets that must be present and must not equal their example value. */
const REQUIRED_SECRETS = ["SESSION_SECRET", "DATABASE_URL"] as const;

const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * The key that reads stored secrets (D102).
 *
 * Not in `REQUIRED_SECRETS`, because an install with no mail server and no
 * backup destination needs no such key and should not be refused a boot over
 * one. It is checked when it is present, and separately when something that
 * needs it is configured: a wrong or truncated key fails at the moment the
 * password is read, which is inside a queue drain at three in the morning, and
 * that is the wrong place to discover it.
 */
const MIN_SECRET_KEY_LENGTH = 32;

/**
 * Exits non-zero on the first sign that this process is running with example
 * or missing credentials. Called from `src/index.ts` before the server binds.
 */
export function assertProdSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const problems: string[] = [];

  for (const name of REQUIRED_SECRETS) {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      problems.push(`${name} is missing`);
      continue;
    }
    if (EXAMPLE_VALUES[name]?.includes(value.trim())) {
      problems.push(`${name} still holds its .env.example placeholder value`);
    }
  }

  const sessionSecret = env.SESSION_SECRET?.trim();
  if (sessionSecret && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(
      `SESSION_SECRET is ${sessionSecret.length} characters, minimum is ${MIN_SESSION_SECRET_LENGTH}`,
    );
  }

  /**
   * `PUBLIC_BASE_URL`, when there is one, must be a URL a mail client can open
   * (D109).
   *
   * Optional, because an installation with no mail server sends no links. Fail
   * closed when it is present and wrong, because the alternative is what
   * happened: a relative link in a real invite mail, sent, queued as sent, and
   * unusable.
   */
  const baseUrl = (env.PUBLIC_BASE_URL ?? env.PUBLIC_ORIGIN)?.trim();
  if (baseUrl !== undefined && baseUrl !== "") {
    let absolute = false;
    try {
      const parsed = new URL(baseUrl);
      absolute = parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      absolute = false;
    }
    if (!absolute) {
      problems.push(
        `PUBLIC_BASE_URL is ${JSON.stringify(baseUrl)}, which is not an absolute URL. ` +
          'It has to look like "https://vikt.example.com", because every link in ' +
          "every email is built from it",
      );
    }

    /**
     * And absolute is not enough (D113).
     *
     * `https://localhost:5173` passed the check above and was live on an
     * instance served through nginx at a real hostname, so every invite went
     * out linking to a dev server on one machine. Absolute was the wrong
     * question; reachable by the recipient is the right one.
     *
     * Only in production. A development instance *should* hold a local address,
     * and refusing to boot over it would make the guard something to work
     * around rather than something to trust.
     */
    if (absolute && env.NODE_ENV === "production" && isLocalBaseUrl(baseUrl)) {
      problems.push(
        `PUBLIC_BASE_URL is ${JSON.stringify(baseUrl)}, which is a local address. ` +
          "Every link in every email is built from it, so a recipient would get a " +
          "link that opens nothing. Set it to the address this installation is " +
          "reachable at from outside",
      );
    }
  }

  /**
   * A landing page needs somebody to write to (D121).
   *
   * `/integritet` names the controller and how to reach them, which under the
   * GDPR is not decoration: Article 13 requires the identity and contact
   * details, and Article 12 requires that exercising a right be facilitated. A
   * public installation with no address on that page is not lawful to run, and
   * the address belongs to whoever deployed it rather than to whoever wrote the
   * code.
   *
   * Only where the landing page is served, and only in production. A private
   * install has no public privacy page to be wrong, and a development instance
   * should not be refused a boot over a field nobody has filled in yet.
   *
   * Checked here rather than in nginx because this is where a refusal is
   * legible: a container that will not start with a reason in its log beats a
   * page that renders an empty sentence and is read by nobody who can fix it.
   */
  const publicFace =
    env.LANDING_ENABLED === "true" || env.REQUEST_ENABLED === "true";

  if (env.NODE_ENV === "production" && publicFace) {
    const contact = env.CONTACT_EMAIL?.trim() ?? "";
    if (contact === "") {
      problems.push(
        "CONTACT_EMAIL is not set, and LANDING_ENABLED or REQUEST_ENABLED is " +
          "true. /integritet has to name someone the reader can write to " +
          "about their own data, and that person is whoever runs this " +
          "installation",
      );
    }
  }

  /**
   * `SECRET_KEY`, when there is one, and it must be worth having (D102).
   *
   * A four-character key encrypts the mail password into something that looks
   * encrypted and is not, and the failure is invisible: everything works, the
   * dump is "protected", and it takes a second to break. Either set a real one
   * or set none and store no password.
   */
  const secretKeyFile = env.SECRET_KEY_FILE?.trim();
  const secretKey = env.SECRET_KEY?.trim();
  if (secretKey !== undefined && secretKey !== "" && secretKey.length < MIN_SECRET_KEY_LENGTH) {
    problems.push(
      `SECRET_KEY is ${secretKey.length} characters, minimum is ${MIN_SECRET_KEY_LENGTH}. ` +
        "Generate one with `openssl rand -hex 32`",
    );
  }
  if (secretKeyFile && secretKey) {
    problems.push(
      "SECRET_KEY and SECRET_KEY_FILE are both set. The file wins, so the variable is " +
        "either redundant or a mistake. Remove one",
    );
  }

  if (problems.length > 0) {
    process.stderr.write(
      `\nRefusing to start. Fix the environment:\n${problems
        .map((p) => `  - ${p}`)
        .join("\n")}\n\nSee infra/.env.example.\n\n`,
    );
    process.exit(1);
  }
}

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(MIN_SESSION_SECRET_LENGTH),

  /** Loopback by default. nginx is the only thing that should reach this. */
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /**
   * The immediate peer that is allowed to speak for a client: the nginx
   * container's address, or the compose subnet. A comma-separated list of
   * addresses, CIDRs, or proxy-addr names (`loopback`, `uniquelocal`). Empty
   * trusts nothing, which is right when nothing is in front.
   *
   * NOT a hop count — see lib/trust-proxy.ts and DECISIONS.md D14. The old
   * numeric form is rejected at boot rather than misread.
   *
   * Verify it by hitting the API from a cellular IP and checking the logged
   * address is the phone's, not the proxy's.
   */
  TRUST_PROXY: z
    .string()
    .default("")
    .refine((value) => !/^\s*\d+\s*$/.test(value), {
      message:
        "looks like a hop count. It now takes the immediate peer's address or CIDR " +
        '(e.g. "172.31.240.0/24"); a hop count cannot validate the peer and is ' +
        "spoofable. See DECISIONS.md D14.",
    }),

  /**
   * Whether the API drains the outbound mail queue itself (D104).
   *
   * On by default, because the alternative was a separate process nobody ran
   * and a queue that sat still while every visible signal said mail worked.
   * Turn it off only to run `pnpm --filter api mail:worker` instead: two
   * drainers on one queue is how a password reset arrives twice.
   */
  MAIL_WORKER_IN_PROCESS: booleanish.default("true"),

  /** Renamed without a code edit. Also read by the web build and by nginx. */
  APP_NAME: z.string().min(1).default("Vikt"),

  /**
   * `Secure` on the session cookie. True in production, and it must stay true
   * anywhere the app is reachable over the internet. Set false only for plain
   * HTTP on the LAN during development.
   */
  /**
   * The intake floor no user may set a target below (DECISIONS.md D24). The
   * user's own floor can only raise the limit. Configuration rather than a
   * constant so an operator with a reason can move it deliberately, on the
   * server, where the change is visible.
   */
  SYSTEM_INTAKE_FLOOR_KCAL: z.coerce.number().int().min(0).max(20000).default(1200),

  COOKIE_SECURE: booleanish.default("true"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Comma-separated origins allowed to send credentialed requests. */
  CORS_ORIGINS: z.string().default(""),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /**
   * The Ollama host, for the optional LLM layer (phase 8).
   *
   * **Empty by default, and empty means off.** The workstation this talks to is
   * not always on, and §6 is explicit that nothing in phases 1 to 7 may depend
   * on this layer. So an absent URL is a supported configuration rather than a
   * misconfiguration: the features simply do not appear.
   */
  /* ---------------------------------------------------- deployment modes */
  /**
   * What this installation is (D94).
   *
   * Three modes, each an environment variable, each **off by default**, and
   * none of them settable from the admin UI. A self-hoster decides once what
   * their install does and edits `.env`; a toggle in a web interface that turns
   * on outbound mail or exposes a public endpoint is an attack surface, and the
   * blast radius of an admin account being taken over should not include
   * "and now the server sends mail to arbitrary addresses".
   *
   * Off by default because the safe install is the private one: a person who
   * clones this and runs it gets an app for themselves, not a public sign-up
   * page attached to a mail sender.
   */

  /**
   * Serve the landing page at `/`.
   *
   * Off means `/` redirects to `/app` and the landing bundle is never served:
   * a private install has no public face rather than a public face nobody
   * links to.
   *
   * It no longer carries the request form with it. See `REQUEST_ENABLED`
   * (D127): the two are separate questions, and the answer to the second is
   * no far more often than the answer to the first.
   */
  LANDING_ENABLED: booleanish.default("false"),

  /**
   * Accept requests for an invite code, at the unlinked path `/kod` (D127).
   *
   * Off means the page and the endpoint **do not exist** — 404, not a disabled
   * form and not a 403. An endpoint that answers at all is one that can be
   * probed and rate-limited around, and this one takes a name and an address
   * from a stranger.
   *
   * Off by default and independent of `LANDING_ENABLED`, because a landing
   * page is something to read and a request form is something that creates
   * work and responsibility for whoever runs the installation. Most people who
   * want the first do not want the second.
   */
  REQUEST_ENABLED: booleanish.default("false"),

  /**
   * Every phase 8 surface. Off means they are **absent**, not greyed out.
   *
   * Requires `OLLAMA_URL` as well: a flag on with no host to talk to would be
   * an app advertising features that cannot work, which is worse than an app
   * that does not mention them.
   */
  LLM_ENABLED: booleanish.default("false"),

  /* -------------------------------------------------------- outbound mail */
  /**
   * SMTP, and every field optional (D88).
   *
   * An empty `SMTP_HOST` means email is **off**, and the app boots and works
   * anyway: a self-hosted install with no mail server keeps its manual paths,
   * because the alternative is an app that refuses to start over a feature its
   * owner never wanted. What the features do without it is degrade — a reset
   * link cannot be sent, so the reset endpoint says so, and an approved invite
   * shows its code on screen for the admin to pass on by hand.
   */
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  /** What recipients see in the From header. */
  SMTP_FROM: z.string().default("Vikt <noreply@localhost>"),
  /**
   * STARTTLS on 587 by default; `true` for implicit TLS on 465.
   */
  SMTP_SECURE: booleanish.default("false"),
  /**
   * Where this installation is reachable, as an absolute URL (D109).
   *
   * `https://vikt.example.com`, no trailing slash. Every link in every email is
   * built from it, and without it a link would be relative, which is fine in a
   * page and useless in an inbox: no mail client has a base to resolve it
   * against. `assertProdSecrets` refuses a value that is not absolute.
   */
  PUBLIC_BASE_URL: z.string().default(""),

  /**
   * The former name for the same thing, still read as a fallback (D109).
   *
   * Kept so an existing deployment does not lose its links on upgrade. The boot
   * log says to move it, and it should then be removed: two variables meaning
   * one thing is how the two-manifest and two-drainer defects both started.
   */
  PUBLIC_ORIGIN: z.string().default(""),

  OLLAMA_URL: z.string().default(""),

  /**
   * Two tiers, per §6 phase 8.
   *
   * The small one is on the interactive path — someone is watching a spinner
   * while it parses their breakfast — so it is chosen for latency. The large
   * one only runs queued work, where slow is acceptable and better output is
   * not.
   */
  OLLAMA_MODEL_SMALL: z.string().default("gemma4:e4b"),
  OLLAMA_MODEL_LARGE: z.string().default("qwen3.6:27b"),

  /**
   * The interactive budget. Short on purpose: a person is waiting, and the
   * honest answer after this long is "not available", which is a path this app
   * already has.
   *
   * Generous enough to survive a **cold model load**, which is the case that
   * actually breaks a short timeout: an unloaded 9 GB model took 50 s to answer
   * a trivial prompt on this hardware, against 0.56 s warm.
   */
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(500).max(120000).default(20000),

  /** Queued generation, where nobody is watching. */
  OLLAMA_JOB_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(180000),
});

export type Env = z.infer<typeof envSchema> & { corsOrigins: string[] };

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    process.stderr.write(
      `\nRefusing to start. Invalid environment:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n")}\n\nSee infra/.env.example.\n\n`,
    );
    process.exit(1);
  }

  cached = {
    ...parsed.data,
    corsOrigins: parsed.data.CORS_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
  return cached;
}

/**
 * Which modes are on, for the boot log (D94).
 *
 * Printed once at startup so nobody has to infer an installation's shape from
 * which screens happen to render. The three lines an operator most often wants
 * are exactly the three that are optional.
 */
export function describeModes(env: Env, mailEnabled = false): string {
  const on = (label: string, active: boolean, detail = "") =>
    `${label}=${active ? "on" : "off"}${active && detail ? ` (${detail})` : ""}`;

  return [
    on("landing", env.LANDING_ENABLED),
    on("request", env.REQUEST_ENABLED),
    /**
     * Mail is no longer an environment question (D102). It is on when the
     * settings table holds a server whose password the app can actually read,
     * which only the mailer knows, so the caller passes that in rather than
     * this function learning to reach the database.
     */
    on("mail", mailEnabled),
    on("llm", env.LLM_ENABLED && env.OLLAMA_URL.trim() !== "", env.OLLAMA_URL),
  ].join("  ");
}
