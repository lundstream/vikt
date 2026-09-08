/**
 * Streaks and the sober counter — CLAUDE.md §4.6.
 *
 * A streak counts **days with any log entry** (weight, food or daily), not days
 * of compliance. That is §3's rule, not a stylistic choice: a streak that breaks
 * when you eat badly punishes honesty and teaches people to stop logging on
 * exactly the days worth logging. One grace day per rolling seven keeps the
 * chain alive, because a single missed morning is not a lapse and rendering it
 * as one is the failure state this product does not have.
 *
 * Pure. No I/O, no clock — `asOf` is passed in.
 */
import { addDays, eachDay } from "./trend.js";

/** Missed days tolerated inside any rolling window of this many days. */
export const GRACE_WINDOW_DAYS = 7;
export const GRACE_DAYS_PER_WINDOW = 1;

/**
 * The current streak, counting back from `asOf`.
 *
 * Walks backwards and stops at the first day that would put more than one
 * missed day inside the trailing week. `asOf` itself not being logged does not
 * end the streak: the day is not over, and a counter that resets at midnight
 * and recovers when you log at breakfast is a counter that lies for eight hours
 * every morning.
 */
export function currentStreak(
  loggedDays: ReadonlySet<string>,
  asOf: string,
): { days: number; graceUsed: number; startedOn: string | null } {
  let days = 0;
  let graceUsed = 0;
  let startedOn: string | null = null;

  // Nothing logged at all is a streak of zero, not a streak that spent its
  // grace day walking backwards through an empty set.
  if (loggedDays.size === 0) return { days: 0, graceUsed: 0, startedOn: null };

  // Today is allowed to be empty without ending anything.
  let cursor = loggedDays.has(asOf) ? asOf : addDays(asOf, -1);

  const missesInWindow: string[] = [];

  for (;;) {
    if (loggedDays.has(cursor)) {
      days += 1;
      startedOn = cursor;
    } else {
      // Only misses inside the trailing window still count against the budget.
      const windowStart = addDays(cursor, GRACE_WINDOW_DAYS - 1);
      while (missesInWindow.length > 0 && missesInWindow[0]! > windowStart) {
        missesInWindow.shift();
      }
      if (missesInWindow.length + 1 > GRACE_DAYS_PER_WINDOW) break;

      missesInWindow.push(cursor);
      graceUsed += 1;
    }

    cursor = addDays(cursor, -1);

    // A streak cannot precede the first day ever logged.
    if (cursor < earliest(loggedDays)) break;
  }

  return { days, graceUsed, startedOn };
}

function earliest(days: ReadonlySet<string>): string {
  let min: string | null = null;
  for (const day of days) if (min === null || day < min) min = day;
  return min ?? "9999-12-31";
}

/** Days between two `YYYY-MM-DD` dates, inclusive of neither end. */
export function daysBetween(from: string, to: string): number {
  let count = 0;
  for (const _day of eachDay(from, to)) count += 1;
  return Math.max(0, count - 1);
}

/* ------------------------------------------------------ the sober counter */

/**
 * How an unlogged day is treated by the sober counter (D35).
 *
 * This is the third time absent-is-not-zero has come up, and here it has teeth:
 * `daily_log.alcohol_units` is nullable *and* a day may have no `daily_log` row
 * at all, so "null or zero means sober" would count every day nobody logged as
 * a dry day. The counter would then grow fastest for the person who stopped
 * using the app, and a savings rule keyed on it would pay out for silence.
 *
 * So an unlogged day is **unknown**, and unknown breaks the chain of *knowing*
 * rather than the chain of not drinking. The two modes are:
 *
 *  - `strict` (the default): the counter only spans days actually logged. A gap
 *    ends the count, and the UI says the count runs from the last gap;
 *  - `assumeSober`: a gap counts as a dry day. Available because some people
 *    genuinely only open the app when something happened, and for them the
 *    strict reading is useless. It is opt-in, and the UI names which rule is
 *    running so the number is never ambiguous.
 *
 * There is deliberately no third mode that guesses.
 */
export type UnloggedDayRule = "strict" | "assumeSober";

export type SoberCount = {
  /** Days since the last recorded drink, or null when it cannot be told. */
  days: number | null;
  /** The last day with a non-zero alcohol figure, if there is one. */
  lastDrinkOn: string | null;
  /**
   * Why the count is what it is. `no_data` when nothing is logged at all,
   * `gap` when a strict count stopped at an unlogged day, `since_drink` when it
   * runs from a recorded drink, `never_recorded` when every logged day is dry,
   * `seeded` when it runs from the date on the profile (D44).
   */
  basis: "no_data" | "gap" | "since_drink" | "never_recorded" | "seeded";
  /** The day the count starts from, so the UI can say "sedan 4 mars". */
  countingFrom: string | null;
  rule: UnloggedDayRule;
};

export type AlcoholDay = {
  localDate: string;
  /** Null means the day was logged but this field was left blank. */
  alcoholUnits: number | null;
};

export type SoberOptions = {
  rule?: UnloggedDayRule;
  /**
   * A last-drink date from the profile, for a run that started before the app
   * did (D44).
   *
   * Someone eighty days sober when they install this has no `daily_log` rows to
   * build a counter from, and telling them to backfill eighty days to see a
   * number they already know is how a feature goes unused. One date replaces
   * all of it.
   *
   * It is a **floor on the count, not a source of dry days**: days before it are
   * not claimed to be anything, and any logged drink after it wins, because a
   * recorded fact beats a remembered one.
   */
  seedLastDrinkOn?: string | null;
};

/**
 * Days since the last drink.
 *
 * A day logged with a blank alcohol field is treated exactly like an unlogged
 * one: the row's existence says something was recorded, not that this
 * particular question was answered.
 */
export function daysSinceLastDrink(
  days: readonly AlcoholDay[],
  asOf: string,
  options: UnloggedDayRule | SoberOptions = "strict",
): SoberCount {
  const { rule = "strict", seedLastDrinkOn = null } =
    typeof options === "string" ? { rule: options } : options;

  /** A seed dated in the future is not yet a fact about anything. */
  const seed =
    seedLastDrinkOn !== null && seedLastDrinkOn <= asOf ? seedLastDrinkOn : null;

  const known = new Map<string, number>();
  for (const day of days) {
    if (day.alcoholUnits === null || !Number.isFinite(day.alcoholUnits)) continue;
    // A row at or before the seed is superseded by it: the seed is the later
    // statement about the same stretch of time.
    if (seed !== null && day.localDate <= seed) continue;
    known.set(day.localDate, day.alcoholUnits);
  }

  const seeded = (): SoberCount => ({
    days: daysBetween(seed!, asOf),
    lastDrinkOn: seed!,
    basis: "seeded",
    countingFrom: addDays(seed!, 1),
    rule,
  });

  if (known.size === 0) {
    if (seed !== null) return seeded();
    return { days: null, lastDrinkOn: null, basis: "no_data", countingFrom: null, rule };
  }

  /**
   * The earliest day with a usable row. Below it there is no logging history at
   * all, which is a different thing from a hole in the middle of one: the seed
   * covers `[seed, earliestLog)`, and a gap inside the logged era is still a
   * gap under the strict rule (D35).
   */
  const earliestLog = earliest(new Set(known.keys()));

  let count = 0;
  let cursor = asOf;

  for (;;) {
    const units = known.get(cursor);

    if (units !== undefined && units > 0) {
      return {
        days: count,
        lastDrinkOn: cursor,
        basis: "since_drink",
        countingFrom: addDays(cursor, 1),
        rule,
      };
    }

    // Walked off the bottom of the logged era. The seed answers for everything
    // below it; without one there is simply nothing older to find.
    if (cursor < earliestLog) {
      if (seed !== null) return seeded();
      return {
        days: count,
        lastDrinkOn: null,
        basis: "never_recorded",
        countingFrom: earliestLog,
        rule,
      };
    }

    if (units === undefined && rule === "strict") {
      // An unlogged day inside the logged era. Strict stops rather than
      // assuming, because an unlogged day is unknown and not dry.
      return {
        days: count,
        lastDrinkOn: null,
        basis: "gap",
        countingFrom: addDays(cursor, 1),
        rule,
      };
    }

    count += 1;
    cursor = addDays(cursor, -1);
  }
}

/** The set of days with any log entry, for {@link currentStreak}. */
export function buildLoggedDays(sources: {
  weight?: readonly { localDate: string }[];
  food?: readonly { localDate: string }[];
  daily?: readonly { localDate: string }[];
}): Set<string> {
  const days = new Set<string>();
  for (const rows of [sources.weight, sources.food, sources.daily]) {
    for (const row of rows ?? []) days.add(row.localDate);
  }
  return days;
}
