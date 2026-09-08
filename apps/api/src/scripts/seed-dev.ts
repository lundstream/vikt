/**
 * Creates the shared development account, `test@example.test`.
 *
 *   pnpm --filter api seed:dev
 *   pnpm --filter api seed:dev -- --days 60      # with a weight series to look at
 *
 * The password comes from `SEED_PASSWORD` in the environment, and the account
 * exists on every developer's machine, so this must never touch anything real.
 * See {@link assertDevOnly}.
 */
import "../lib/dotenv.js";
import { parseArgs } from "node:util";
import { cliArgs } from "./args.js";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "../db/index.js";
import { hashPassword } from "../auth/password.js";
import { findUserByEmail, insertProfile, insertUser } from "../repositories/users.repo.js";
import { saveWeightEntry } from "../services/weight.service.js";
import { saveManualIntake } from "../services/intake.service.js";
import { addDays } from "shared";

export const SEED_EMAIL = process.env.SEED_EMAIL?.trim() || "test@example.test";

/**
 * The development account's password, from the environment.
 *
 * It used to be a literal in this file, which meant it was a real password
 * committed to a public repository: anyone who cloned the tree knew the
 * credentials of an account that exists on every machine that has run this
 * script. The address is harmless and stays as a default; the password is not,
 * so it has none.
 *
 * Absent, the script refuses rather than inventing one. A generated password
 * nobody is told is a seeded account nobody can use, and a default password is
 * the thing this change exists to remove.
 */
export const SEED_PASSWORD = process.env.SEED_PASSWORD?.trim() ?? "";

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefused";
  }
}

/**
 * Refuses to run anywhere but development.
 *
 * This plants a known email with a published password. Running it against
 * production would create a working account that anyone who has read this file
 * can sign in to. The check is on `NODE_ENV`, and an unset `NODE_ENV` counts as
 * *not* development — the same fail-closed posture as `assertProdSecrets()`.
 * The database name is checked too, so a development-looking process pointed at
 * the production URL still refuses.
 */
export function assertDevOnly(env: NodeJS.ProcessEnv = process.env): void {
  const nodeEnv = env.NODE_ENV?.trim();
  if (nodeEnv !== "development") {
    throw new SeedRefused(
      `Refusing to seed: NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : "unset"}, not "development". ` +
        `This creates ${SEED_EMAIL} with a password from the environment.`,
    );
  }

  if ((env.SEED_PASSWORD ?? "").trim() === "") {
    throw new SeedRefused(
      "Refusing to seed: SEED_PASSWORD is not set. Put one in .env — see .env.example. " +
        "There is deliberately no default, because a default is a published password.",
    );
  }

  const url = env.DATABASE_URL;
  if (!url) throw new SeedRefused("Refusing to seed: DATABASE_URL is not set.");

  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, "");
  } catch {
    throw new SeedRefused("Refusing to seed: DATABASE_URL is not a valid URL.");
  }

  // Belt and braces: a development NODE_ENV pointed at a production database is
  // exactly the mistake this is here to stop.
  if (!/(^|_)(dev|development|test)$/.test(databaseName) && databaseName !== "vikt") {
    throw new SeedRefused(
      `Refusing to seed: database "${databaseName}" does not look like a development ` +
        `database. Expected something ending in _dev or _test, or "vikt".`,
    );
  }
}

/** Creates the account if it is missing. Returns its id either way. */
export async function seedDevUser(db: Db): Promise<{ userId: string; created: boolean }> {
  const existing = await findUserByEmail(db, SEED_EMAIL);
  if (existing) return { userId: existing.id, created: false };

  const user = await insertUser(db, {
    email: SEED_EMAIL,
    passwordHash: await hashPassword(SEED_PASSWORD),
    displayName: "Test",
  });
  await insertProfile(user.id, db, { heightCm: "180.0", timezone: "Europe/Stockholm" });

  return { userId: user.id, created: true };
}

/**
 * A plausible weight and intake series, so the trend line has something to draw
 * without waiting three months. Deliberately noisy: a clean curve would hide
 * exactly the smoothing behaviour the chart exists to show.
 */
export async function seedDevSeries(userId: string, db: Db, days: number): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let written = 0;

  for (let offset = days - 1; offset >= 0; offset--) {
    const localDate = addDays(today, -offset);

    // Skip roughly one day in seven, so the gap handling is visible too.
    if (offset % 7 === 3) continue;

    const drift = -0.06 * (days - offset);
    const noise = Math.sin(offset * 1.7) * 0.6 + Math.cos(offset * 0.6) * 0.35;

    await saveWeightEntry(userId, db, {
      clientUuid: randomUUID(),
      localDate,
      weightKg: Number((92 + drift + noise).toFixed(2)),
      // Backfilled history, and the chart shows it as such.
      source: "import",
    });

    await saveManualIntake(userId, db, {
      clientUuid: randomUUID(),
      localDate,
      kcal: Math.round(2100 + Math.sin(offset * 0.9) * 260),
    });

    written += 1;
  }

  return written;
}

/**
 * Only run when executed directly, so the tests can import the guard without
 * seeding. `pathToFileURL` rather than string-building: a Windows path becomes
 * `file:///C:/...` with three slashes, and hand-rolling that comparison made
 * this a silent no-op.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { values } = parseArgs({
    args: cliArgs(),
    options: { days: { type: "string", default: "0" } },
  });

  try {
    assertDevOnly();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }

  const { db, client } = createDb(process.env.DATABASE_URL!, { max: 1 });

  try {
    const { userId, created } = await seedDevUser(db);
    process.stdout.write(
      `${created ? "Created" : "Already there"}: ${SEED_EMAIL} / ${SEED_PASSWORD}\n`,
    );

    const days = Number(values.days);
    if (Number.isInteger(days) && days > 0) {
      const written = await seedDevSeries(userId, db, days);
      process.stdout.write(`Seeded ${written} days of weight and intake.\n`);
    }
  } catch (error) {
    process.stderr.write(`Seed failed: ${(error as Error).message}\n`);
    await client.end();
    process.exit(1);
  }

  await client.end();
}
