/**
 * Queues one of each mail template to a given address, for looking at.
 *
 *   pnpm --filter api mail:samples -- --to you@example.com
 *
 * Queued, not sent: the drainer picks them up like anything else, which is the
 * point of D109's change to the test button. What this proves when the mails
 * arrive is the whole path, not just the transport.
 *
 * A script rather than an endpoint. Sending four messages to an arbitrary
 * address is exactly the shape D102 refused to expose over HTTP, and the
 * argument for the test button — that the recipient is the session's own
 * address — does not extend to this.
 */
import "../lib/dotenv.js";
import { parseArgs } from "node:util";
import { cliArgs } from "./args.js";
import { loadEnv } from "../env.js";
import { createDb } from "../db/index.js";
import { createMailer } from "../mail/sender.js";
import { drainOnce } from "../mail/drainer.js";
import { queueMail } from "../mail/queue.js";
import { linkTo } from "../lib/links.js";
import {
  inviteApprovedMail,
  inviteRequestedMail,
  passwordResetMail,
  testMail,
  wrap,
} from "../mail/templates.js";
import { defaultMaintenanceBody } from "../services/announcement.service.js";

const { values } = parseArgs({ args: cliArgs(), options: { to: { type: "string" } } });
if (!values.to) {
  process.stderr.write("Usage: mail:samples -- --to you@example.com\n");
  process.exit(2);
}

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
const mailer = createMailer(() => db, env);
await mailer.refresh();

if (!mailer.enabled) {
  process.stderr.write("Mail is not configured. Set it up under Administration, Mejlserver.\n");
  await client.end();
  process.exit(1);
}

/** The announcement body, rendered the way the app renders it for a reader. */
const announcement = {
  template: "announcement_maintenance" as const,
  subject: "Planerat underhåll i Vikt",
  text: defaultMaintenanceBody({
    weekday: "torsdag",
    date: "10 september",
    from: "21:00",
    to: "23:00",
  }),
  html: "",
};
announcement.html = wrap(announcement.text);

const SAMPLES = [
  inviteApprovedMail({
    code: "3F7K-9QMT-2XBW",
    link: linkTo(env, "/app/register", { kod: "3F7K-9QMT-2XBW" }),
  }),
  inviteRequestedMail(),
  passwordResetMail({ link: linkTo(env, "/app/nytt-losenord", { token: "exempel" }), hours: 2 }),
  announcement,
  testMail(),
];

for (const mail of SAMPLES) {
  await queueMail(db, values.to, mail);
  process.stdout.write(`queued ${mail.template}\n`);
}

const sent = await drainOnce(db, mailer);
process.stdout.write(`\ndrained: ${sent} sent to ${values.to}\n`);

await client.end();
