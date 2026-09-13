/**
 * A fixture account where alcohol is a real part of the picture (D155 addendum).
 *
 * D155 observed that the two character tones drop alcohol from a broad answer
 * when there is almost none of it: the development account had two standard
 * drinks in twenty-eight days and none in the last seven, and a tone capped at
 * five or six sentences dropped the thinnest domain. That was recorded as
 * observed rather than fixed, because it is arguably the right call.
 *
 * It leaves the real question unanswered, though: does the coach speak to
 * alcohol **when there is something to speak to**? This account is built so
 * that it has to. Several units on several days inside the last week, sober
 * days among them, and enough of every other domain that the answer is a
 * choice between domains rather than a shortage of them.
 *
 * Deliberately not a heavy drinker. The point is a normal week with drink in
 * it, because a fixture that is alarming tests the coach's restraint rather
 * than its coverage, and D155's rules already forbid the alarming reply.
 *
 * Idempotent: re-running tops up the same account rather than making a second.
 *
 *   pnpm --filter api exec tsx src/scripts/seed-alcohol-fixture.ts [asOf]
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
import { saveDailyLog, saveActivity } from "../services/daily.service.js";
import { saveManualIntake } from "../services/intake.service.js";
import { createManualFood, saveFoodEntry } from "../services/food.service.js";
import { addDays } from "shared";

const EMAIL = "alkohol@example.test";
const PASSWORD = "fixture-account-password";
const TIMEZONE = "Europe/Stockholm";
const AS_OF = process.argv[2] ?? new Date().toISOString().slice(0, 10);

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
      displayName: "Alkoholfixtur",
      timezone: TIMEZONE,
      consent: true,
    },
    "seed-alcohol-fixture",
  );
  console.log(`created ${EMAIL}`);
  [account] = await db.select().from(users).where(eq(users.id, created.user.id)).limit(1);
}

const userId = account!.id;
await db.update(profiles).set({ timezone: TIMEZONE, heightCm: "180" }).where(eq(profiles.userId, userId));

/**
 * Twenty-eight days, every one of them logged.
 *
 * Thick on purpose: the question is whether the coach picks alcohol out of a
 * full sheet, and a sheet with gaps in the other domains would let it win by
 * default.
 */
const DAYS = 28;

/**
 * Alcohol, in Swedish standard drinks.
 *
 * Weekends carry most of it and two weekdays carry some, which is the shape a
 * normal week has. Sober days are explicit zeros rather than absences: a zero
 * here is a measurement, and the distinction is the whole of D44.
 */
function unitsOn(offset: number): number {
  const weekday = new Date(`${addDays(AS_OF, offset)}T12:00:00Z`).getUTCDay();
  if (weekday === 5) return 4;   // Friday
  if (weekday === 6) return 5;   // Saturday
  if (weekday === 3) return 2;   // Wednesday
  return 0;
}

let alcoholDays = 0;
let alcoholUnits = 0;

for (let back = DAYS - 1; back >= 0; back -= 1) {
  const localDate = addDays(AS_OF, -back);
  const units = unitsOn(-back);
  if (units > 0) {
    alcoholDays += 1;
    alcoholUnits += units;
  }

  await saveWeightEntry(userId, db, {
    clientUuid: randomUUID(),
    localDate,
    weightKg: Number((88.0 - (DAYS - back) * 0.03).toFixed(1)),
    source: "manual",
    dateSource: "chosen",
  });

  await saveManualIntake(userId, db, {
    clientUuid: randomUUID(),
    localDate,
    // Drinking days eat more, which is true and gives the coach two facts that
    // sit beside each other without a cause between them (D155).
    kcal: 2100 + units * 120 + (back % 4) * 60,
  });

  await saveDailyLog(userId, db, {
    clientUuid: randomUUID(),
    localDate,
    sleepHours: units >= 4 ? 6 : 7.5,
    energy: units >= 4 ? 2 : 4,
    mood: 4,
    steps: 8000 + (back % 5) * 700,
    alcoholUnits: units,
  });

  if (back % 3 === 0) {
    await saveActivity(userId, db, {
      clientUuid: randomUUID(),
      localDate,
      activityType: "walk",
      durationMin: 45,
      intensity: 3,
    });
  }
}

/**
 * Meals, so the sheet is genuinely full.
 *
 * Without these the food section says nothing was logged, which leaves one
 * fewer domain competing for room in a reply capped at six sentences — and the
 * whole question here is whether alcohol survives a **full** sheet. A fixture
 * that makes the answer easier is not a test.
 */
const MEALS = [
  { name: "Havregrynsgröt", kcalPer100: 60 },
  { name: "Kycklingfilé", kcalPer100: 110 },
  { name: "Rotfruktsgratäng", kcalPer100: 95 },
  { name: "Laxfilé med potatis", kcalPer100: 130 },
  { name: "Grekisk yoghurt", kcalPer100: 59 },
];

const items = [];
for (const meal of MEALS) {
  items.push(await createManualFood(userId, db, { name: meal.name, kcalPer100: meal.kcalPer100 }));
}

for (let back = 6; back >= 0; back -= 1) {
  const localDate = addDays(AS_OF, -back);
  for (const slot of [0, 1, 2]) {
    const item = items[(back + slot) % items.length]!;
    await saveFoodEntry(userId, db, {
      clientUuid: randomUUID(),
      localDate,
      foodItemId: item.id,
      grams: 200 + slot * 50,
      mealSlot: (["breakfast", "lunch", "dinner"] as const)[slot]!,
      // Typed by hand rather than parsed, so it is confirmed and certain.
      confidence: 1,
      confirmed: true,
    });
  }
}

console.log(`seeded ${DAYS} days ending ${AS_OF}`);
console.log(`meals: ${MEALS.length} foods across the last 7 days, 3 entries a day`);
console.log(`alcohol: ${alcoholUnits} units across ${alcoholDays} days, ${DAYS - alcoholDays} sober`);
console.log(`sign in with ${EMAIL} / ${PASSWORD}`);

await client.end();
