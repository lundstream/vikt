/**
 * What a day's intake is — defined once, here.
 *
 * There are two sources and there will stay two: a `manual_intake` row, which is
 * one number for the whole day, and the sum of that day's `food_entries`, which
 * phase 3 introduces. The precedence is fixed:
 *
 *   1. the manual row, if there is one — it is the deliberate override, and the
 *      schema comment on `manual_intake` says so;
 *   2. otherwise the sum of the day's food entries;
 *   3. otherwise **absent**, which is not the same as zero.
 *
 * That distinction is the whole point of this file. A day with no log is a day
 * we know nothing about; a day logged as 0 kcal is a fast. The coverage gate in
 * §4.2 counts the first as missing and the second as present, and conflating
 * them would let a month of not logging read as a month of eating nothing —
 * which, given `meanIntake = totalLoggedIntake / daysInWindow`, would drag the
 * TDEE estimate down by hundreds of kcal without anything looking wrong.
 *
 * Phase 3 adds food entries to the input and changes nothing else. It must not
 * fork this logic.
 */

export type DailyIntakeSources = {
  /** One row per day at most, per the `manual_intake_day_key` index. */
  manual?: readonly { localDate: string; kcal: number }[];
  /** Many rows per day. Phase 3. */
  foodEntries?: readonly { localDate: string; kcal: number }[];
};

/**
 * Resolved intake by `local_date`. A date **present** in the map has intake
 * logged, including when the value is 0; a date **absent** has none. Use
 * {@link intakeOn} rather than reading it directly, so `0` is never mistaken
 * for "missing" by a stray `||`.
 */
export type IntakeIndex = ReadonlyMap<string, number>;

/**
 * Total a list of daily amounts, staying **null** when there is nothing to add.
 *
 * `[].reduce((a, b) => a + b, 0)` is 0, and 0 is a claim: it says the day was
 * logged and came to nothing. A screen that reduces an empty list and prints the
 * result tells the user they ate nothing today, when the truth is that nothing
 * has been logged yet. That is the same conflation this file exists to prevent,
 * so the summing primitive lives next to the rule rather than being open-coded
 * on each screen.
 */
export function sumOrNull(values: readonly number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value));
  if (usable.length === 0) return null;
  return usable.reduce((total, value) => total + value, 0);
}

export function buildIntakeIndex(sources: DailyIntakeSources): IntakeIndex {
  const index = new Map<string, number>();

  // Food entries first, so a manual row can overwrite the day's total.
  for (const entry of sources.foodEntries ?? []) {
    if (!Number.isFinite(entry.kcal)) continue;
    index.set(entry.localDate, (index.get(entry.localDate) ?? 0) + entry.kcal);
  }

  for (const row of sources.manual ?? []) {
    if (!Number.isFinite(row.kcal)) continue;
    index.set(row.localDate, row.kcal);
  }

  return index;
}

/** The day's intake, or `null` when nothing was logged. Never coerces 0. */
export function intakeOn(index: IntakeIndex, localDate: string): number | null {
  const value = index.get(localDate);
  return value === undefined ? null : value;
}

/** Whether the day counts as logged for the coverage gate (§4.2). */
export function hasIntakeOn(index: IntakeIndex, localDate: string): boolean {
  return index.has(localDate);
}

export type IntakeCoverage = {
  /** Days in the window with a resolved intake value. */
  daysWithIntake: number;
  daysInWindow: number;
  /** `daysWithIntake / daysInWindow`, 0 for an empty window. */
  coverage: number;
  /**
   * Sum over the whole window. Days with no log contribute nothing, which is
   * exactly what §4.2's `totalLoggedIntake` means and exactly why the coverage
   * gate exists — see DECISIONS.md D19.
   */
  totalLoggedKcal: number;
};

/** Coverage over an explicit list of `local_date`s, in order. */
export function coverageOver(index: IntakeIndex, localDates: readonly string[]): IntakeCoverage {
  let daysWithIntake = 0;
  let totalLoggedKcal = 0;

  for (const localDate of localDates) {
    const value = intakeOn(index, localDate);
    if (value === null) continue;
    daysWithIntake += 1;
    totalLoggedKcal += value;
  }

  const daysInWindow = localDates.length;
  return {
    daysWithIntake,
    daysInWindow,
    coverage: daysInWindow === 0 ? 0 : daysWithIntake / daysInWindow,
    totalLoggedKcal,
  };
}
