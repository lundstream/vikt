/**
 * A fixture account whose body obeys 7700 kcal per kg (D166).
 *
 * Samband's intake pane draws a dashed line for what a week's intake should do
 * to the trend, from a measured maintenance figure. To see that line do its job
 * on the screen, the points have to be ones that ought to land on it: every day
 * weighed, every day's intake logged, and each day's weight the previous day's
 * plus that day's surplus over 7700, from a maintenance of 2 500 kcal.
 *
 * Intake is held at one level for six weeks and then another, because that is
 * the case the weekly calc can honestly put on the line (`weekly-intake.ts`).
 * The weeks right after the change sit off it while the trend catches up, which
 * is worth seeing too and is what the note under the chart says.
 *
 * Weights are rounded to one decimal, as a scale shows them, so the points carry
 * a little of the noise real ones do.
 *
 * Idempotent in the way the alcohol fixture is: re-running writes the same days
 * again, and each save replaces that day's row.
 *
 *   pnpm --filter api exec tsx src/scripts/seed-samband-fixture.ts [asOf]
 */
import "../lib/dotenv.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { addDays, KCAL_PER_KG } from "shared";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { profiles, users } from "../db/schema.js";
import { mintInvite } from "../services/invite.service.js";
import { register } from "../services/auth.service.js";
import { saveWeightEntry } from "../services/weight.service.js";
import { saveManualIntake } from "../services/intake.service.js";

const EMAIL = "samband@example.test";
const PASSWORD = "fixture-account-password";
const TIMEZONE = "Europe/Stockholm";
const AS_OF = process.argv[2] ?? new Date().toISOString().slice(0, 10);

const MAINTENANCE = 2500;
const LEVELS = [2000, 2800];
const WEEKS_PER_LEVEL = 6;
const DAYS = LEVELS.length * WEEKS_PER_LEVEL * 7 + 14;

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

let [account] = await db.select().from(users).where(eq(users.email, EMAIL)).limit(1);

if (!account) {
  const invite = await mintInvite(db, {});
  const created = await register(
    { db, sessionTtlDays: env.SESSION_TTL_DAYS },
    {
      inviteCode: invite.code,
      email: EMAIL,
      password: PASSWORD,
      displayName: "Sambandsfixtur",
      timezone: TIMEZONE,
      consent: true,
    },
    "seed-samband-fixture",
  );
  console.log(`created ${EMAIL}`);
  [account] = await db.select().from(users).where(eq(users.id, created.user.id)).limit(1);
}

const userId = account!.id;
await db.update(profiles).set({ timezone: TIMEZONE, heightCm: "180" }).where(eq(profiles.userId, userId));

let weight = 96;
for (let index = 0; index < DAYS; index += 1) {
  const localDate = addDays(AS_OF, index - (DAYS - 1));
  // The last fortnight stays at the second level, so the trend has answered
  // for every whole week before it.
  const level = Math.min(Math.floor(index / (WEEKS_PER_LEVEL * 7)), LEVELS.length - 1);
  const kcal = LEVELS[level]!;

  await saveWeightEntry(userId, db, {
    clientUuid: randomUUID(),
    localDate,
    weightKg: Number(weight.toFixed(1)),
    source: "manual",
    dateSource: "chosen",
  });
  await saveManualIntake(userId, db, { clientUuid: randomUUID(), localDate, kcal });

  weight += (kcal - MAINTENANCE) / KCAL_PER_KG;
}

console.log(`seeded ${DAYS} days ending ${AS_OF}: ${WEEKS_PER_LEVEL} weeks at each of ${LEVELS.join(" and ")} kcal`);
console.log(`maintenance the body obeys: ${MAINTENANCE} kcal`);
// The password is the constant above, not printed (§7).
console.log(`sign in with ${EMAIL}; the password is PASSWORD in this file`);

await client.end();
