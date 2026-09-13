/**
 * A fixture account for verification passes, with a deliberately awkward week.
 *
 * Two things this project could not otherwise exercise against real data:
 *
 *  - **a week below the four-day rule.** Every real account here logs daily, so
 *    the Sunday sweep's quiet path had nothing to be quiet about;
 *  - **a rising trend.** D140 says the restraint on the way down is the whole
 *    design of the Peppig profile, and every live run so far has been a week
 *    that went well.
 *
 * Its timezone is deliberately not the owner's. A sweep instant that is Sunday
 * evening in Auckland is Sunday morning in Stockholm, so this account can be
 * swept on its own without writing reviews for anybody else.
 *
 * Idempotent: re-running tops up the same account rather than making a second.
 */
import "../lib/dotenv.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { profiles, users } from "../db/schema.js";
import { mintInvite } from "../services/invite.service.js";
import { register } from "../services/auth.service.js";
import { saveWeightEntry } from "../services/weight.service.js";
import { addDays } from "shared";

const EMAIL = "fixture@example.test";
const PASSWORD = "fixture-account-password";
const TIMEZONE = "Pacific/Auckland";
/** The day the series ends on. Everything else is counted back from it. */
const AS_OF = process.argv[2] ?? "2026-09-12";

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
      displayName: "Fixture",
      timezone: TIMEZONE,
      consent: true,
    },
    "seed-fixture",
  );
  console.log(`created ${EMAIL}`);
  [account] = await db.select().from(users).where(eq(users.id, created.user.id)).limit(1);
}

const userId = account!.id;
await db.update(profiles).set({ timezone: TIMEZONE, heightCm: "178" }).where(eq(profiles.userId, userId));

/**
 * Which days carry a weight, counted back from `AS_OF`.
 *
 * The week 27 to 21 days back gets **three**, which is the case the four-day
 * rule exists for. The last seven days get five, which is the minimum a review
 * is written from, so the same account serves both verifications.
 */
const OFFSETS = [
  /**
   * The quiet week: **three** days, which is one below the rule.
   *
   * Far enough back to be its own Monday-to-Sunday week with nothing either
   * side of it. The first attempt put it at 26 to 21 days back and quietly
   * landed a fourth day inside the same week, which is exactly the sort of
   * off-by-one a fixture is supposed to make visible rather than hide.
   */
  -68, -66, -63,
  // Two ordinary weeks.
  -20, -19, -18, -17, -15, -14,
  -13, -12, -11, -10, -9, -8,
  // The last seven days: five of them.
  -6, -5, -3, -2, 0,
];

/** Rising, because that is the week nobody had run the coach against. */
const START_KG = 78.0;
const PER_DAY = 0.06;

for (const offset of OFFSETS) {
  const localDate = addDays(AS_OF, offset);
  const weightKg = (START_KG + (28 + offset) * PER_DAY).toFixed(1);

  await saveWeightEntry(userId, db, {
    clientUuid: randomUUID(),
    localDate,
    weightKg: Number(weightKg),
    source: "manual",
    // A backfill, which is what a seeded history is: the date was chosen, not
    // read off a device clock (D61).
    dateSource: "chosen",
  });
}

console.log(`seeded ${OFFSETS.length} weighings ending ${AS_OF}, rising from ${START_KG} kg`);
console.log(`timezone: ${TIMEZONE}`);
console.log(`sign in with ${EMAIL} / ${PASSWORD}`);

await client.end();
