import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { adminLog, mailSettings } from "../db/schema.js";
import type { Env } from "../env.js";
import {
  SECRET_USES,
  decryptSecret,
  encryptSecret,
  secretsAvailable,
} from "../lib/secrets.js";

/**
 * Mail settings, read and written (D102).
 *
 * Everything here is deliberately unscoped by user: there is one mail server per
 * installation, and the routes that reach these functions are behind
 * `requireAdmin`. They are named in the isolation rule's `allowUnscoped` with
 * that reasoning, like the rest of `admin.service.ts`.
 *
 * **The password never leaves.** `readSettings` returns whether one is stored,
 * not what it is, and only `mailerConfig` decrypts — which is called by the
 * transport factory and by nothing that answers a request.
 */

const SINGLETON = "singleton";

export type MailSecurity = "starttls" | "tls" | "none";

/** What an admin sees. Note the absence of the password. */
export type MailSettingsView = {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  /** Whether a password is stored, which is all anybody gets to know. */
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
  /**
   * Whether the stored password can actually be decrypted.
   *
   * False with a password stored means `SECRET_KEY` is missing or has changed,
   * and the screen has to say so: mail will fail to authenticate, and "wrong
   * password" is a much worse explanation than "the key that reads it is gone".
   */
  secretsReadable: boolean;
};

export type MailSettingsInput = {
  host: string;
  port: number;
  security: MailSecurity;
  username: string;
  /** Absent leaves the stored password alone. Empty string clears it. */
  password?: string | undefined;
  fromAddress: string;
  fromName: string;
};

export type Actor = { id: string; email: string };

async function row(db: Db) {
  const [found] = await db.select().from(mailSettings).where(eq(mailSettings.id, SINGLETON)).limit(1);
  return found ?? null;
}

/** The settings, or null when mail has never been configured. */
export async function readMailSettings(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MailSettingsView | null> {
  const found = await row(db);
  if (!found) return null;

  const hasPassword = found.passwordEncrypted !== "";

  return {
    host: found.host,
    port: found.port,
    security: found.security,
    username: found.username,
    hasPassword,
    fromAddress: found.fromAddress,
    fromName: found.fromName,
    updatedAt: found.updatedAt.toISOString(),
    updatedByEmail: found.updatedByEmail,
    secretsReadable:
      !hasPassword ||
      (secretsAvailable(env) &&
        decryptSecret(found.passwordEncrypted, SECRET_USES.mailPassword, env) !== null),
  };
}

/**
 * Writes the settings, and records who did it.
 *
 * The audit row is not optional and not the route's job. Whoever controls the
 * SMTP server receives **every password reset this app sends**, so a change here
 * is a change to who can take over any account, and it is the single most
 * important line the log will ever hold.
 *
 * Returns the reason it refused rather than throwing, because "no encryption key
 * is configured" is an operator problem with a specific fix and deserves to
 * reach the screen as itself.
 */
export async function writeMailSettings(
  db: Db,
  actor: Actor,
  input: MailSettingsInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true } | { ok: false; reason: "no_secret_key" }> {
  const existing = await row(db);

  let encrypted = existing?.passwordEncrypted ?? "";
  if (input.password !== undefined) {
    if (input.password === "") {
      encrypted = "";
    } else {
      if (!secretsAvailable(env)) return { ok: false, reason: "no_secret_key" };
      encrypted = encryptSecret(input.password, SECRET_USES.mailPassword, env);
    }
  }

  const values = {
    id: SINGLETON,
    host: input.host.trim(),
    port: input.port,
    security: input.security,
    username: input.username.trim(),
    passwordEncrypted: encrypted,
    fromAddress: input.fromAddress.trim(),
    fromName: input.fromName.trim(),
    updatedAt: new Date(),
    updatedByEmail: actor.email,
  };

  await db
    .insert(mailSettings)
    .values(values)
    .onConflictDoUpdate({ target: mailSettings.id, set: values });

  await recordChange(db, actor, existing === null ? "mail.configure" : "mail.update", values.host);
  return { ok: true };
}

/**
 * What the transport needs, password included.
 *
 * The only function that decrypts. Returns null when mail is not configured or
 * when the password cannot be read, and the caller treats both as "mail is off",
 * because a transport built with a password it could not decrypt would fail at
 * send time with an authentication error that blames the wrong thing.
 */
export async function mailerConfig(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  user: string;
  pass: string;
  from: string;
} | null> {
  const found = await row(db);
  if (!found || found.host.trim() === "" || found.fromAddress.trim() === "") return null;

  let pass = "";
  if (found.passwordEncrypted !== "") {
    const decrypted = decryptSecret(found.passwordEncrypted, SECRET_USES.mailPassword, env);
    if (decrypted === null) return null;
    pass = decrypted;
  }

  return {
    host: found.host,
    port: found.port,
    /**
     * nodemailer's `secure` means implicit TLS from the first byte, which is
     * 465. `requireTLS` on a plain connection is STARTTLS, and it is
     * `requireTLS` rather than the default opportunistic upgrade so a server
     * that does not offer STARTTLS fails instead of silently sending the
     * password in clear.
     */
    secure: found.security === "tls",
    requireTLS: found.security === "starttls",
    user: found.username,
    pass,
    from:
      found.fromName.trim() === ""
        ? found.fromAddress
        : `${found.fromName} <${found.fromAddress}>`,
  };
}

/**
 * Imports `SMTP_*` from the environment, once, on the first boot after D102.
 *
 * An operator who upgrades should not have their mail stop working because the
 * settings moved. This runs at startup, does nothing when a row already exists,
 * and logs loudly enough that the variables get removed rather than lingering as
 * a second source of truth nobody is reading.
 *
 * Returns what happened so the caller can log it. It never throws: a failed
 * import must not stop the process from starting, because the operator can
 * always configure mail from the screen.
 */
export async function importMailSettingsFromEnv(
  db: Db,
  config: Env,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"imported" | "already-configured" | "nothing-to-import" | "no_secret_key"> {
  if (await row(db)) return "already-configured";

  const host = config.SMTP_HOST.trim();
  if (host === "" || config.SMTP_FROM.trim() === "") return "nothing-to-import";

  const password = config.SMTP_PASS;
  if (password !== "" && !secretsAvailable(env)) return "no_secret_key";

  /**
   * The old `SMTP_SECURE` boolean maps to implicit TLS, and its absence to
   * STARTTLS rather than to nothing. That is what nodemailer did with these
   * settings before, so the import reproduces the behaviour the operator
   * already had rather than a weaker one.
   */
  const security: MailSecurity = config.SMTP_SECURE ? "tls" : "starttls";

  const from = config.SMTP_FROM.trim();
  const match = from.match(/^(.*?)\s*<([^>]+)>$/);

  await db.insert(mailSettings).values({
    id: SINGLETON,
    host,
    port: config.SMTP_PORT,
    security,
    username: config.SMTP_USER,
    passwordEncrypted:
      password === "" ? "" : encryptSecret(password, SECRET_USES.mailPassword, env),
    fromAddress: (match?.[2] ?? from).trim(),
    fromName: (match?.[1] ?? "").trim(),
    updatedAt: new Date(),
    updatedByEmail: null,
  });

  return "imported";
}

/**
 * The audit row for a settings change.
 *
 * Written here rather than at the route, for D95's reason: a route that
 * remembers to log is a route that will one day forget, and this is the one it
 * would matter most to forget.
 */
async function recordChange(db: Db, actor: Actor, action: string, host: string): Promise<void> {
  await db.insert(adminLog).values({
    actorId: actor.id,
    actorEmail: actor.email,
    action,
    subject: host,
    detail: null,
  });
}
