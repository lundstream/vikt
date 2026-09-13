/**
 * Who the Sunday sweep would consider, and why each one got what it got.
 *
 * A throwaway view for a verification pass: the sweep's counts say "two were
 * quiet" and this says which two and how many days they logged.
 */
import "../lib/dotenv.js";
import { sql } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { profiles, users, weeklyReviews } from "../db/schema.js";
import { loggedDaysIn, weekStartOf } from "../services/review.service.js";
import { eq } from "drizzle-orm";

const asOf = process.argv[2] ?? "2026-09-06";
const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

const weekStart = weekStartOf(asOf);
console.log(`week ${weekStart} .. ${asOf}`);

const rows = await db
  .select({ userId: profiles.userId, email: users.email, timezone: profiles.timezone })
  .from(profiles)
  .innerJoin(users, eq(users.id, profiles.userId))
  .where(sql`${users.disabledAt} is null`);

for (const row of rows) {
  const logged = await loggedDaysIn(row.userId, db, weekStart, asOf);
  const reviews = await db
    .select({ weekStart: weeklyReviews.weekStart })
    .from(weeklyReviews)
    .where(eq(weeklyReviews.userId, row.userId));

  console.log(
    `${row.email.padEnd(34)} tz=${row.timezone.padEnd(18)} logged=${logged} ` +
      `reviews=[${reviews.map((review) => review.weekStart).join(", ")}]`,
  );
}

await client.end();
