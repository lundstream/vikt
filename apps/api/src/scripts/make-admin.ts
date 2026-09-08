/**
 * Grants or revokes the admin flag (D89).
 *
 *   pnpm --filter api admin -- --email you@example.com
 *   pnpm --filter api admin -- --email you@example.com --revoke
 *
 * A CLI script and never a UI action, deliberately. An endpoint that can make
 * an account an admin is a privilege escalation waiting for one missing check,
 * and there is no version of this app where granting admin needs to be
 * convenient: it happens once, for the owner, on the machine that runs the
 * database.
 */
import "../lib/dotenv.js";
import { parseArgs } from "node:util";
import { cliArgs } from "./args.js";
import { eq } from "drizzle-orm";
import { loadEnv } from "../env.js";
import { createDb } from "../db/index.js";
import { users } from "../db/schema.js";

const { values } = parseArgs({
  args: cliArgs(),
  options: {
    email: { type: "string" },
    revoke: { type: "boolean", default: false },
  },
});

if (!values.email) {
  process.stderr.write("Usage: admin -- --email <address> [--revoke]\n");
  process.exit(2);
}

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);

const updated = await db
  .update(users)
  .set({ isAdmin: !values.revoke })
  .where(eq(users.email, values.email.trim().toLowerCase()))
  .returning({ email: users.email, isAdmin: users.isAdmin });

if (updated.length === 0) {
  process.stderr.write(`No account with that address: ${values.email}\n`);
  await client.end();
  process.exit(1);
}

process.stdout.write(
  `${updated[0]!.email} is ${updated[0]!.isAdmin ? "now an admin" : "no longer an admin"}.\n`,
);
await client.end();
