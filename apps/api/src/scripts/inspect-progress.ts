/**
 * Read-only. Runs `getProgress` for one account and validates the result
 * against the response schema, so a row that the service returns but the
 * serializer rejects is visible as such.
 *
 *   tsx src/scripts/inspect-progress.ts <email> [asOf]
 */
import "../lib/dotenv.js";
import { eq } from "drizzle-orm";
import { progressResponseSchema } from "shared";
import { createDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { getProgress } from "../services/progress.service.js";

const email = process.argv[2];
const asOf = process.argv[3] ?? new Date().toISOString().slice(0, 10);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !email) {
  process.stderr.write("usage: DATABASE_URL=... tsx inspect-progress.ts <email> [asOf]\n");
  process.exit(1);
}

const { db, client } = createDb(databaseUrl, { max: 1 });

try {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error(`no such user: ${email}`);

  const progress = await getProgress(user.id, db, asOf);

  process.stdout.write(`service returned ${progress.milestones.length} milestone(s)\n`);
  for (const milestone of progress.milestones) {
    process.stdout.write(
      `  ${milestone.metric} ${milestone.targetValue}  status=${milestone.status.state}` +
        `  progress=${milestone.progress}  projectedDays=${milestone.projectedDays}` +
        `  affordable=${milestone.rewardAffordable}  until=${milestone.daysUntilAffordable}\n`,
    );
  }

  const parsed = progressResponseSchema.safeParse(progress);
  process.stdout.write(`\nresponse schema: ${parsed.success ? "ok" : "REJECTED"}\n`);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      process.stdout.write(`  ${issue.path.join(".")}: ${issue.message}\n`);
    }
  }
} finally {
  await client.end();
}
