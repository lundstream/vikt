import type {
  CreateManualIntake,
  DateRangeQuery,
  IntakeIndex,
  MacroEntry,
  ManualIntake,
} from "shared";
import { buildIntakeIndex, eachDay, intakeOn, toNumber, toNumberOrNull } from "shared";
import type { Db } from "../db/index.js";
import {
  deleteIntakeForDayExcept,
  deleteManualIntake,
  listManualIntake,
  upsertManualIntakeByClientUuid,
  type ManualIntakeRow,
} from "../repositories/intake.repo.js";
import { listFoodEntries } from "../repositories/food.repo.js";
import { notFound } from "../lib/errors.js";
import { assertDateSource, serverDate } from "../lib/date-source.js";

/**
 * Manual daily intake — a single number per day.
 *
 * Phase 3 brings real food logging, but adaptive TDEE (§4.2) needs 28 days of
 * intake history before it says anything, so the series has to start filling up
 * now. `manual_intake` also stays afterwards as the escape hatch for restaurant
 * meals and guesses.
 */

function toEntry(row: ManualIntakeRow): ManualIntake {
  return {
    id: row.id,
    clientUuid: row.clientUuid,
    localDate: row.localDate,
    kcal: row.kcal,
    proteinG: row.proteinG,
    note: row.note,
  };
}

export async function saveManualIntake(
  userId: string,
  db: Db,
  input: CreateManualIntake,
): Promise<ManualIntake> {
  /**
   * The date and where it came from have to agree (D61). Checked here rather
   * than in the schema, because the answer depends on the server's own clock
   * and a Zod refinement cannot see it.
   */
  assertDateSource(input.localDate, input.dateSource, serverDate());

  const row = await db.transaction(async (tx) => {
    await deleteIntakeForDayExcept(userId, tx, input.localDate, input.clientUuid);

    return upsertManualIntakeByClientUuid(userId, tx, {
      clientUuid: input.clientUuid,
      localDate: input.localDate,
      kcal: input.kcal,
      proteinG: input.proteinG ?? null,
      note: input.note ?? null,
    });
  });

  return toEntry(row);
}

export async function getManualIntake(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<ManualIntake[]> {
  const rows = await listManualIntake(userId, db, range);
  return rows.map(toEntry);
}

/**
 * Removes a manual row, so the day falls back to its food entries.
 *
 * §3: every user-created row ships with a delete. This one had none, and the
 * consequence was not cosmetic — a manual total entered in the morning silently
 * outranked every meal logged after it, with no way to take it back short of
 * overwriting it with a guess.
 */
export async function removeManualIntake(userId: string, db: Db, id: string): Promise<void> {
  if (!(await deleteManualIntake(userId, db, id))) {
    throw notFound("There is no such intake row.");
  }
}

/**
 * A day's intake, resolved once, for every consumer.
 *
 * `calc/intake.ts` has always defined this: the manual row if there is one,
 * otherwise the sum of that day's food entries, otherwise **absent**. What was
 * missing was anywhere that actually assembled both halves. Four call sites
 * each built the index themselves and each passed `manual` only, so a day with
 * food logged and no manual row read as a day nobody logged.
 *
 * The consequences were not cosmetic:
 *
 *  - the dashboard said "Inte än" for calories on a day with a full food log;
 *  - **`estimateTdee` counted those days as unlogged**, so they were excluded
 *    from the §4.2 coverage gate. Enough of them and maintenance silently falls
 *    back to the Mifflin formula despite the user logging every day;
 *  - `meanIntake` divides by `daysLogged`, so the mean was not dragged toward
 *    zero the way the D23 bug was. It was computed over a *subsample*: only the
 *    days logged one particular way. That is worse than it sounds, because
 *    which method someone reaches for is not random.
 *
 * So there is now one function that reads both tables, and no caller constructs
 * an index. Forgetting the food half is no longer something a call site can do.
 */
export async function resolveIntake(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<IntakeIndex> {
  const [manualRows, foodRows] = await Promise.all([
    listManualIntake(userId, db, range),
    listFoodEntries(userId, db, range),
  ]);

  return buildIntakeIndex({
    manual: manualRows.map((row) => ({ localDate: row.localDate, kcal: row.kcal })),
    // `food_entries.kcal` is `numeric`, which Drizzle hands back as a string.
    // Parsed at the boundary, per §3.
    foodEntries: foodRows.map((row) => ({
      localDate: row.localDate,
      kcal: toNumber(row.kcal),
    })),
  });
}

/** One day's resolved intake, or null when nothing was logged that day. */
export async function resolveIntakeOn(
  userId: string,
  db: Db,
  localDate: string,
): Promise<number | null> {
  const index = await resolveIntake(userId, db, { from: localDate, to: localDate });
  return intakeOn(index, localDate);
}

/**
 * The same days, with their macros rather than only their calories.
 *
 * This lives here rather than in a macro service of its own because it answers
 * the same question `resolveIntake` does — what was eaten on a day — and that
 * question has one owner (D44, D47). A second reader of `food_entries` that
 * summed macros would be free to disagree with this one about what a manual day
 * means, and would eventually.
 *
 * A manual day is **one entry with a number and, at most, protein**. That is
 * what `manual_intake` actually holds, and it is why macro coverage exists: the
 * day's carbohydrate is not zero, it is unrecorded, and the difference has to
 * survive all the way to the bar the user looks at.
 *
 * Manual wins over food entries for a day, exactly as in `resolveIntake`. Two
 * definitions of "manual wins" would be one too many.
 */
export async function resolveMacros(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<Map<string, MacroEntry[]>> {
  const [manualRows, foodRows] = await Promise.all([
    listManualIntake(userId, db, range),
    listFoodEntries(userId, db, range),
  ]);

  const byDay = new Map<string, MacroEntry[]>();

  for (const row of foodRows) {
    const day = byDay.get(row.localDate) ?? [];
    day.push({
      // `numeric` arrives as a string from Drizzle; parsed at the boundary (§3).
      kcal: toNumber(row.kcal),
      proteinG: toNumberOrNull(row.proteinG),
      carbsG: toNumberOrNull(row.carbsG),
      fatG: toNumberOrNull(row.fatG),
      fiberG: toNumberOrNull(row.fiberG),
    });
    byDay.set(row.localDate, day);
  }

  for (const row of manualRows) {
    byDay.set(row.localDate, [
      {
        kcal: row.kcal,
        proteinG: row.proteinG,
        carbsG: null,
        fatG: null,
        fiberG: null,
      },
    ]);
  }

  return byDay;
}

/**
 * Every day in a range, with the intake the app agrees it had.
 *
 * Through `resolveIntake`, which is the only thing allowed to answer this
 * question (D44, D47). Days with nothing logged come back as `null` rather than
 * being omitted, so a caller drawing a series gets the gaps as gaps instead of
 * having to reconstruct which days were missing.
 */
export async function getIntakeSeries(
  userId: string,
  db: Db,
  range: { from: string; to: string },
): Promise<{ from: string; to: string; days: { localDate: string; kcal: number | null }[] }> {
  const index = await resolveIntake(userId, db, range);

  return {
    from: range.from,
    to: range.to,
    days: [...eachDay(range.from, range.to)].map((localDate) => ({
      localDate,
      kcal: intakeOn(index, localDate),
    })),
  };
}
