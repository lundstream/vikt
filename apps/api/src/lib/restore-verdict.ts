/**
 * When a restore check is due, when it is old, and whether a restore worked
 * (D168). Pure, so the rules are tested without a database or `pg_restore`.
 */

/** A check runs after a scheduled backup once the last one is this old. */
export const RESTORE_CHECK_EVERY_DAYS = 30;

/**
 * Past this, the Backup screen says the last check is old, in words.
 *
 * Five days past the schedule's thirty, so a check that ran a day or two late,
 * because the backup ran late, is not called old, and a schedule that has
 * stopped entirely is.
 */
export const RESTORE_CHECK_OLD_AFTER_DAYS = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

export function restoreCheckAgeDays(startedAt: Date, now: Date): number {
  return Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS);
}

/** Never checked, or last checked at least thirty days ago. */
export function restoreCheckDue(last: { startedAt: Date } | null, now: Date): boolean {
  return last === null || restoreCheckAgeDays(last.startedAt, now) >= RESTORE_CHECK_EVERY_DAYS;
}

/** What a database looks like, from the few counts a restore is judged by. */
export type DatabaseShape = {
  /** Every table in the `public` schema, by name. */
  tables: string[];
  /** Rows across those tables. */
  rows: number;
  /** Entries in Drizzle's migration table. */
  migrations: number;
  /** Rows in `weight_log`, the one table an installation in use cannot have empty. */
  weightRows: number;
};

export type RestoreVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Whether the scratch database is a restore of the live one.
 *
 * **Not equality.** The dump was taken earlier than the comparison, so the live
 * database has had time to gain rows, and a check that failed on that would fail
 * every night. What a broken restore looks like instead is structural, and that
 * is what is refused:
 *
 * - a table the live database has and the restore does not;
 * - no migrations recorded at all, which is not a Vikt database;
 * - **more** migrations than the live database, which is a dump from a newer
 *   schema than the code that would restore it;
 * - an empty restore of a database that has data, which is the quiet failure:
 *   `pg_restore` can exit 0 having restored the schema and nothing else;
 * - no weight readings restored when the live database has some.
 *
 * Fewer migrations than live is **not** refused: a dump taken before a deploy
 * that added one restores correctly, and the API brings it up to date on start.
 */
export function judgeRestore(live: DatabaseShape, restored: DatabaseShape): RestoreVerdict {
  const have = new Set(restored.tables);
  const missing = live.tables.filter((table) => !have.has(table));
  if (missing.length > 0) {
    return { ok: false, reason: `tables missing from the restore: ${missing.join(", ")}` };
  }
  if (restored.migrations === 0) {
    return { ok: false, reason: "the restore records no migrations, so it is not a Vikt database" };
  }
  if (restored.migrations > live.migrations) {
    return {
      ok: false,
      reason: `the dump has ${restored.migrations} migrations and the running schema ${live.migrations}: it is newer than this code`,
    };
  }
  if (live.rows > 0 && restored.rows === 0) {
    return { ok: false, reason: "the restore has the schema and no rows at all" };
  }
  if (live.weightRows > 0 && restored.weightRows === 0) {
    return { ok: false, reason: "the restore has no weight readings and the live database does" };
  }
  return { ok: true };
}
