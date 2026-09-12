/**
 * Runs the boot-time VAPID check against the development database.
 *
 * The same function the server calls at boot, so a verification pass can watch
 * the changed-key path without restarting anything with a doctored key.
 *
 * `pnpm --filter api exec tsx src/scripts/vapid-check-probe.ts [public-key]`
 */
import "../lib/dotenv.js";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { checkVapidKey } from "../lib/vapid-watch.js";

const env = loadEnv();
const pretend = process.argv[2];
const config = pretend ? { ...env, VAPID_PUBLIC_KEY: pretend } : env;

const { db, client } = createDb(env.DATABASE_URL);

const check = await checkVapidKey(db, config);
console.log(JSON.stringify(check));

if (check.status === "changed" && check.subscriptions > 0) {
  console.log(
    `WARN the VAPID public key changed since the last boot. ${check.subscriptions} ` +
      "subscription(s) are bound to the previous pair and will answer 403 until " +
      "their owners turn reminders off and on again. Nothing has been deleted",
  );
}

await client.end();
