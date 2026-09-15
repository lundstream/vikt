/**
 * Restore check, from a command (D168).
 *
 *   pnpm --filter api restore-check                       # the newest backup in the directory
 *   pnpm --filter api restore-check /path/vikt-….dump.enc # a file somewhere else
 *
 * On the Docker host, inside the API container, which has `pg_restore`,
 * `SECRET_KEY`, the database and `/backups` already:
 *
 *   docker exec vikt-api-1 node dist/restore-check.js
 *
 * Restores into a scratch database, judges it against the live one, drops the
 * scratch database, and records the result where Administration, Backup shows
 * it. Exits 1 when the backup did not restore. Prints no secret and no
 * connection string.
 */
import "../lib/dotenv.js";
import { createDb } from "../db/index.js";
import { loadEnv } from "../env.js";
import { runRestoreCheck } from "../services/restore-check.service.js";

const env = loadEnv();
const { db, client } = createDb(env.DATABASE_URL);
const file = process.argv[2];

try {
  const outcome = await runRestoreCheck(db, env, { trigger: "command", ...(file ? { file } : {}) });

  if (outcome.ok) {
    console.log(`restored: ${outcome.fileName}`);
    console.log(`${outcome.tables} tables, ${outcome.rows} rows, ${outcome.migrations} migrations`);
    console.log("the scratch database was dropped; the result is under Administration, Backup");
  } else {
    console.error(`did not restore: ${outcome.fileName ?? "(no file)"}`);
    console.error(outcome.reason);
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
