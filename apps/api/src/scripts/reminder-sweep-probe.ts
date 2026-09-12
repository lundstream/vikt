/**
 * One reminder sweep against the development database, with nothing sent.
 *
 * The send is replaced by a recorder, so running this cannot deliver a
 * notification to anybody: it answers "what would this sweep do right now", and
 * it prints the counts the scheduler would have logged.
 *
 * Run with `pnpm --filter api exec tsx src/scripts/reminder-sweep-probe.ts`,
 * optionally with an ISO instant to sweep as if it were then.
 */
import "../lib/dotenv.js";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { dueNow, runReminders } from "../services/reminder.service.js";
import type { PushPayload, PushTarget, SendOutcome } from "../lib/push.js";

const now = process.argv[2] ? new Date(process.argv[2]) : new Date();

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

const calls: { target: PushTarget; payload: PushPayload }[] = [];
const record = async (target: PushTarget, payload: PushPayload): Promise<SendOutcome> => {
  calls.push({ target, payload });
  return { status: "sent" };
};

console.log(`sweeping as of ${now.toISOString()}`);

const due = await dueNow(db, now);
console.log(`due right now: ${due.length}`);
for (const reminder of due) {
  console.log(`  ${reminder.kind} for ${reminder.localDate}${reminder.habitName ? ` (${reminder.habitName})` : ""}`);
}

const result = await runReminders(db, env, now, record);
console.log("result:", JSON.stringify(result));
console.log(`would have sent ${calls.length} notification(s)`);
for (const call of calls) console.log(`  -> ${call.payload.body}`);

await client.end();
