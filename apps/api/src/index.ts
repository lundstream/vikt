import "./lib/dotenv.js";
import { assertProdSecrets, describeModes, loadEnv } from "./env.js";
import { buildApp } from "./app.js";
import { importMailSettingsFromEnv } from "./services/mail-settings.service.js";
import { startBackupScheduler } from "./lib/backup-scheduler.js";
import { startReminderScheduler } from "./lib/reminder-scheduler.js";
import { installBackupCrashGuard } from "./lib/backup-crash-guard.js";
import { startMailDrainer } from "./mail/drainer.js";

/**
 * Fail closed before anything binds. If a secret is missing or still holds its
 * .env.example value, this exits non-zero and the container restart loop makes
 * the misconfiguration loud instead of leaving it running for a year.
 */
assertProdSecrets();

const env = loadEnv();
const app = await buildApp(env);

/**
 * The one-time import of `SMTP_*` into the settings table (D102).
 *
 * An operator upgrading past this change should not have their mail stop
 * working because the settings moved. This runs before the mailer is refreshed,
 * does nothing once a row exists, and says loudly what it did so the variables
 * get removed rather than lingering as a second source of truth nobody reads.
 */
const imported = await importMailSettingsFromEnv(app.db, env);
if (imported === "imported") {
  app.log.warn(
    { host: env.SMTP_HOST },
    "imported SMTP_* into the mail settings table. Remove SMTP_HOST, SMTP_PORT, " +
      "SMTP_USER, SMTP_PASS, SMTP_SECURE and SMTP_FROM from the environment: " +
      "they are no longer read, and mail is edited in the admin screens now.",
  );
} else if (imported === "no_secret_key") {
  app.log.error(
    "SMTP_* is set and SECRET_KEY is not, so the password cannot be stored " +
      "encrypted and mail settings were not imported. Set SECRET_KEY (or " +
      "SECRET_KEY_FILE) and restart.",
  );
}

/** Reads the settings and builds the transport, once, before anything sends. */
await app.mailer.refresh();

/**
 * A backup destination must never take the API down (D132).
 *
 * Installed before the scheduler, because the scheduler is one of the two
 * things that can reach a socket client that throws outside a promise chain.
 * The other is the admin's "test connection" button, which is how this was
 * found: it exited the process.
 */
installBackupCrashGuard(app);

/**
 * The backup schedule (D103), which D96 wrote as a cron line and nobody ever
 * installed. In the process, so it starts when the process does.
 */
startBackupScheduler(app);

/**
 * The reminder tick (D136), which does not start without VAPID keys and says
 * so once when it does not. Same single-instance limit as the mail drainer:
 * two API processes would sweep twice, though the unique index on
 * `reminder_sends` means they still could not send twice.
 */
startReminderScheduler(app);

/**
 * The mail drainer (D104), which D88 made a separate process and nothing ever
 * started. In here, so there is one thing to run.
 */
if (env.MAIL_WORKER_IN_PROCESS) startMailDrainer(app);

try {
  // Loopback by default (CLAUDE.md §2): nginx is the only thing that talks to
  // this. In Docker the equivalent is an internal network with no published
  // ports — see DECISIONS.md D12.
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(
    { appName: env.APP_NAME, trustProxy: env.TRUST_PROXY, cookieSecure: env.COOKIE_SECURE },
    "api up",
  );
  /**
   * Which modes are on, said out loud once (D94).
   *
   * Three of this app's features are optional and off by default, and the only
   * way to tell which an installation has was previously to open it and look
   * for the screens. An operator debugging "why is there no reset mail" should
   * find the answer in the first ten lines of the log.
   */
  /**
   * Mail's mode is the mailer rather than the environment now (D102), so it is
   * passed in: `describeModes` cannot read the database and should not learn to.
   */
  app.log.info({ modes: describeModes(env, app.mailer.enabled) }, "deployment modes");
} catch (error) {
  app.log.error({ err: error }, "failed to start");
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
