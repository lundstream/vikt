import type { DateRangeQuery, TdeeResult, TrendPoint } from "shared";
import { buildLoggedDays, computeTrend, estimateTdee, toNumber, toNumberOrNull } from "shared";
import type { Db } from "../db/index.js";
import { listWeightEntries, type WeightRow } from "../repositories/weight.repo.js";
import { listFoodEntries } from "../repositories/food.repo.js";
import { listDailyLogs } from "../repositories/daily.repo.js";
import { findProfile } from "../repositories/users.repo.js";
import { resolveIntake } from "./intake.service.js";
import { notFound } from "../lib/errors.js";

/**
 * The weight series, and everything derived from it.
 *
 * This exists for the same reason `resolveIntake` does (D44, D47): a rule that
 * lives in a shared module is only as good as the call sites that use it, and
 * four of them once reached past the intake resolver with results that took
 * months to notice. `computeTrend` and `estimateTdee` are correct; what was
 * missing was one place that assembles their inputs, so that assembling them
 * wrongly is not something a caller can do.
 *
 * The eslint rule `ownership/derived-data-owner` enforces it: nothing outside
 * this file and the weight repository may read `weight_log`.
 *
 * Every function here is pure assembly. No formula lives in this file — that
 * is `packages/shared/src/calc/`, so the number the server reports and the
 * number the browser would compute cannot diverge.
 */

/**
 * The days with **any** log entry, for the streak (§4.6).
 *
 * A separate concept from intake and deliberately so: this asks whether the
 * person turned up, not what they ate. It reads `food_entries` for the fact
 * that a row exists on a day, never for its calories, which is why it does not
 * and must not go through `resolveIntake`.
 *
 * It lives here rather than in the progress service for the same reason
 * everything else in this file does: one owner per derived concept, so the
 * question "which days count as logged?" has exactly one answer (D47).
 */
export async function resolveLoggedDays(
  userId: string,
  db: Db,
): Promise<Set<string>> {
  const [weight, food, daily] = await Promise.all([
    listWeightEntries(userId, db, {}),
    listFoodEntries(userId, db, {}),
    listDailyLogs(userId, db, {}),
  ]);

  return buildLoggedDays({ weight, food, daily });
}

/** The raw rows, for the screens that list readings rather than plot them. */
export async function getWeightRows(
  userId: string,
  db: Db,
  range: DateRangeQuery = {},
): Promise<WeightRow[]> {
  return listWeightEntries(userId, db, range);
}

/**
 * The smoothed series, extended to `asOf`.
 *
 * Extending matters: without it the line stops at the last reading, so a week
 * of not weighing in renders as the line ending rather than flattening.
 */
export async function resolveTrend(
  userId: string,
  db: Db,
  asOf: string,
): Promise<TrendPoint[]> {
  const rows = await listWeightEntries(userId, db, {});
  return computeTrend(
    rows.map((row) => ({ localDate: row.localDate, weightKg: toNumber(row.weightKg) })),
    { to: asOf },
  );
}

/**
 * Today's maintenance figure.
 *
 * Takes both inputs from their owners, which is the whole point: the trend from
 * here and the intake from `resolveIntake`. The version of this that passed
 * `manual` only counted every food-logged day as unlogged and quietly dropped
 * users below the §4.2 coverage gate.
 */
export async function resolveTdee(
  userId: string,
  db: Db,
  asOf: string,
): Promise<{ tdee: TdeeResult; trend: TrendPoint[] }> {
  const profile = await findProfile(userId, db);
  if (!profile) throw notFound("This account has no profile row.");

  const [trend, intake] = await Promise.all([
    resolveTrend(userId, db, asOf),
    resolveIntake(userId, db, {}),
  ]);

  return {
    trend,
    tdee: estimateTdee({
      trend,
      intake,
      asOf,
      profile: {
        sex: profile.sex,
        birthDate: profile.birthDate,
        heightCm: toNumberOrNull(profile.heightCm),
        activityFactor: toNumber(profile.activityFactor),
      },
    }),
  };
}
