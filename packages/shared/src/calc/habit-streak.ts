/**
 * The streak for one habit (D137), counting under §3's no-failure rule.
 *
 * Three kinds of day, and the whole design is in telling them apart:
 *
 *  - **ticked** — the habit was done. The streak counts these.
 *  - **missed** — the checklist was answered that day and this habit was not
 *    ticked. One of these per rolling seven does not break the chain, which is
 *    §4.6's grace rule, applied here for the same reason it exists there: a
 *    single missed morning is not a lapse, and rendering it as one is the
 *    failure state this product does not have.
 *  - **unknown** — nothing was answered that day at all. Not a miss. It does
 *    not spend the grace day, and it does not get counted as kept either.
 *
 * What to do with unknown is the same question D35 answered for the sober
 * counter, and it gets the same answer: **a count may not claim days it knows
 * nothing about.** So the walk stops at the first unknown day and the result
 * says it stopped there, which lets the screen say "räknat sedan" the day the
 * count actually starts from rather than showing a bare number whose meaning
 * depends on invisible state.
 *
 * There is deliberately no second mode. D35 has one because a savings rule can
 * be keyed on the sober counter, so the number on screen and the number in the
 * ledger must be able to mean the same thing for an occasional logger. Nothing
 * is keyed on a habit streak, so a permissive mode here would only let the
 * number overstate itself.
 *
 * Pure. No clock: `asOf` is passed in.
 */
import { addDays } from "./trend.js";
import { GRACE_DAYS_PER_WINDOW, GRACE_WINDOW_DAYS } from "./streak.js";

/**
 * Why the count is what it is, so the copy can be specific.
 *
 * `no_data` nothing has ever been answered for this habit; `gap` the walk
 * stopped at a day nobody answered; `running` it stopped because the grace
 * budget ran out on an answered day; `from_first` it reached the first day this
 * habit has any record of.
 */
export type HabitStreakBasis = "no_data" | "gap" | "running" | "from_first";

export type HabitStreak = {
  /** Days ticked in the current chain. */
  days: number;
  /** Missed days the chain is spending its grace on. */
  graceUsed: number;
  /** The first day of the chain, or null when there is none. */
  startedOn: string | null;
  /** The day the walk stopped at, which is what "räknat sedan" names. */
  countingFrom: string | null;
  basis: HabitStreakBasis;
  /** Whether the habit is ticked on `asOf` itself. */
  checkedToday: boolean;
};

export type HabitStreakInput = {
  /** Local dates this habit was ticked. */
  ticked: ReadonlySet<string>;
  /**
   * Local dates the checklist was answered at all, for **any** habit.
   *
   * Wider than this habit's own rows on purpose: somebody who ticked two of
   * three habits on Tuesday answered the list on Tuesday, and the third habit's
   * Tuesday is a miss rather than a day nobody was there for. Narrower than
   * "any log entry at all", because weighing yourself says nothing about
   * whether you took the vitamin.
   */
  answered: ReadonlySet<string>;
  /** Today, in the user's own timezone. Never read from a clock in here. */
  asOf: string;
};

export function habitStreak({ ticked, answered, asOf }: HabitStreakInput): HabitStreak {
  const checkedToday = ticked.has(asOf);

  if (ticked.size === 0) {
    return {
      days: 0,
      graceUsed: 0,
      startedOn: null,
      countingFrom: null,
      basis: "no_data",
      checkedToday: false,
    };
  }

  const earliest = earliestOf(ticked);

  /**
   * Today is allowed to be empty without ending anything: the day is not over,
   * and a counter that resets at midnight and recovers at breakfast lies for
   * eight hours every morning. Same rule as the logging streak.
   */
  let cursor = ticked.has(asOf) ? asOf : addDays(asOf, -1);

  let days = 0;
  let graceUsed = 0;
  let startedOn: string | null = null;
  const missesInWindow: string[] = [];

  for (;;) {
    if (cursor < earliest) {
      return {
        days,
        graceUsed,
        startedOn,
        countingFrom: earliest,
        basis: "from_first",
        checkedToday,
      };
    }

    if (ticked.has(cursor)) {
      days += 1;
      startedOn = cursor;
      cursor = addDays(cursor, -1);
      continue;
    }

    if (!answered.has(cursor)) {
      // Unknown. The chain of knowing ends here, and the result says so rather
      // than counting through a day nobody answered.
      return {
        days,
        graceUsed,
        startedOn,
        countingFrom: addDays(cursor, 1),
        basis: "gap",
        checkedToday,
      };
    }

    // Answered and not ticked: a miss, against the grace budget.
    const windowStart = addDays(cursor, GRACE_WINDOW_DAYS - 1);
    while (missesInWindow.length > 0 && missesInWindow[0]! > windowStart) {
      missesInWindow.shift();
    }
    if (missesInWindow.length + 1 > GRACE_DAYS_PER_WINDOW) {
      return {
        days,
        graceUsed,
        startedOn,
        countingFrom: addDays(cursor, 1),
        basis: "running",
        checkedToday,
      };
    }

    missesInWindow.push(cursor);
    graceUsed += 1;
    cursor = addDays(cursor, -1);
  }
}

function earliestOf(days: ReadonlySet<string>): string {
  let min: string | null = null;
  for (const day of days) if (min === null || day < min) min = day;
  return min ?? "9999-12-31";
}
