/**
 * Read-only. Lists every milestone row per account, so "two were created and
 * one renders" can be told apart from "one was created and the other was
 * refused".
 *
 * Diagnosis only: it writes nothing, and it exists because guessing between a
 * silent rejection and a filtered list is exactly the thing that turns a
 * fifteen-minute fix into the wrong fix.
 */
import "../lib/dotenv.js";
import { asc } from "drizzle-orm";
import { createDb } from "../db/index.js";
import { milestones, users } from "../db/schema.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not set.\n");
  process.exit(1);
}

const { db, client } = createDb(databaseUrl, { max: 1 });

try {
  const rows = await db.select().from(milestones).orderBy(asc(milestones.createdAt));
  const accounts = await db.select({ id: users.id, email: users.email }).from(users);
  const emailOf = new Map(accounts.map((row) => [row.id, row.email]));

  process.stdout.write(`${rows.length} milestone row(s) across ${accounts.length} account(s)\n\n`);

  for (const row of rows) {
    process.stdout.write(
      [
        emailOf.get(row.userId) ?? row.userId,
        row.metric,
        `target=${row.targetValue}`,
        `label=${JSON.stringify(row.label)}`,
        `sort=${row.sortOrder}`,
        `achieved=${row.achievedAt?.toISOString() ?? "-"}`,
        `claimed=${row.rewardClaimedAt?.toISOString() ?? "-"}`,
        `created=${row.createdAt?.toISOString() ?? "-"}`,
      ].join("  "),
    );
    process.stdout.write("\n");
  }
} finally {
  await client.end();
}
