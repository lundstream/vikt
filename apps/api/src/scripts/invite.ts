/**
 * Mints an invite code and prints it.
 *
 *   pnpm --filter api invite
 *   pnpm --filter api invite -- --expires 14
 *   pnpm --filter api invite -- --count 3
 *
 * Registration is invite-only, so this is the only way a new account gets made.
 */
import "../lib/dotenv.js";
import { parseArgs } from "node:util";
import { cliArgs } from "./args.js";
import { createDb } from "../db/index.js";
import { formatInviteCode } from "../auth/tokens.js";
import { mintInvite } from "../services/invite.service.js";

const { values } = parseArgs({
  args: cliArgs(),
  options: {
    expires: { type: "string" },
    count: { type: "string", default: "1" },
  },
  allowPositionals: false,
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not set. Copy infra/.env.example to .env first.\n");
  process.exit(1);
}

const count = Number(values.count);
if (!Number.isInteger(count) || count < 1 || count > 50) {
  process.stderr.write("--count must be an integer between 1 and 50.\n");
  process.exit(1);
}

const expiresInDays = values.expires === undefined ? null : Number(values.expires);
if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
  process.stderr.write("--expires must be a positive number of days.\n");
  process.exit(1);
}

const { db, client } = createDb(databaseUrl, { max: 1 });

try {
  for (let i = 0; i < count; i++) {
    const invite = await mintInvite(db, { expiresInDays });
    const expiry = invite.expiresAt
      ? `expires ${invite.expiresAt.toISOString().slice(0, 10)}`
      : "no expiry";
    process.stdout.write(`${formatInviteCode(invite.code)}   (${expiry})\n`);
  }
} catch (error) {
  process.stderr.write(`Could not mint an invite: ${(error as Error).message}\n`);
  await client.end();
  process.exit(1);
}

await client.end();
