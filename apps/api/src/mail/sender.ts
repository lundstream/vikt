import { createTransport, type Transporter } from "nodemailer";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import { mailerConfig } from "../services/mail-settings.service.js";

/**
 * The SMTP transport, and the fact that there may not be one (D88, D102).
 *
 * Mail is optional in the same way the LLM layer is optional: a self-hosted
 * install with no mail server keeps working, and every feature that would have
 * sent something degrades to a manual path instead of failing. So this is a
 * discriminated thing rather than a nullable one — `enabled` is checked at the
 * call site, and there is no way to accidentally call `send` on a transport
 * that does not exist.
 *
 * It never throws. A send that fails comes back as a reason, because the caller
 * is a queue worker whose job is to record the reason and try again later, and
 * an exception there would be a rejected promise that stops a drain.
 *
 * ## What D102 changed
 *
 * The settings come from the database rather than from the environment, so the
 * transport can no longer be built once at boot and kept. It is now built on
 * demand and cached, and `refresh()` throws the cache away — called after an
 * admin saves, so the next send uses the new server without a restart.
 *
 * `enabled` stays a **synchronous boolean** because a dozen call sites read it
 * while deciding what to tell a user, and making it a promise would turn each of
 * those into an await for a question that changes about once a year. It is
 * refreshed at boot and on every save. The cost is that changing the row behind
 * the app's back leaves the flag stale until the next restart, which is a
 * trade worth naming and not worth solving.
 */

export type SendResult =
  | { ok: true }
  | { ok: false; reason: string; permanent: boolean };

export type Mailer = {
  /** False when no mail server is configured. Every caller checks it. */
  enabled: boolean;
  send(input: {
    to: string;
    subject: string;
    text: string;
    html?: string | null;
  }): Promise<SendResult>;
  /** Re-reads the settings. Called at boot and after an admin saves. */
  refresh(): Promise<void>;
};

/**
 * Whether a refusal is worth retrying.
 *
 * SMTP says this itself: 5xx is permanent — a mailbox that does not exist will
 * not exist in ten minutes — and 4xx is temporary. Retrying a permanent failure
 * forever is how a queue fills up with mail that can never be delivered, and
 * giving up on a temporary one loses a message over a restart.
 */
function isPermanent(error: unknown): boolean {
  const code = (error as { responseCode?: number } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

const NOT_CONFIGURED: SendResult = {
  ok: false,
  reason: "mail is not configured",
  permanent: true,
};

/**
 * A mailer backed by the settings table.
 *
 * `transport` is injectable so tests can watch what would have been sent. When
 * it is given, the stored settings are still read for `from` and for `enabled`,
 * so a test exercises the same decisions production makes.
 */
export function createMailer(
  /**
   * A getter rather than the handle.
   *
   * `app.db` is decorated after the mailer is, so capturing it here caught
   * `undefined` and the first refresh threw at startup. Resolving it per call
   * also means a test that swaps the database out gets the new one.
   */
  getDb: () => Db,
  env: Env,
  transport?: Transporter,
): Mailer {
  let cached: { transport: Transporter; from: string } | null = null;

  const mailer: Mailer = {
    enabled: false,

    async refresh() {
      cached = null;
      const config = await mailerConfig(getDb());
      mailer.enabled = config !== null;
      if (config === null) return;

      cached = {
        transport:
          transport ??
          createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            requireTLS: config.requireTLS,
            auth: config.user.trim() === "" ? undefined : { user: config.user, pass: config.pass },
          }),
        from: config.from,
      };
    },

    async send(input) {
      if (!cached) await mailer.refresh();
      if (!cached) return NOT_CONFIGURED;

      try {
        await cached.transport.sendMail({
          from: cached.from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: (error as Error).message.slice(0, 500),
          permanent: isPermanent(error),
        };
      }
    },
  };

  // `env` is kept in the signature because the test harness builds a mailer
  // before the database has a settings row, and a future setting may want it.
  void env;

  return mailer;
}

/**
 * A mailer that is off, for tests and for a process with no database yet.
 *
 * Named rather than assembled inline at each call site, so "off" behaves
 * identically everywhere it is needed.
 */
export function disabledMailer(): Mailer {
  return {
    enabled: false,
    send: async () => NOT_CONFIGURED,
    refresh: async () => {},
  };
}
