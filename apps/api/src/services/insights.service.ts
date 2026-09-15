import type {
  DayMacros,
  InsightsResponse,
  MacroLineDto,
  MacroTargets,
  MacroTargetsDto,
  TdeeResult,
} from "shared";
import {
  addDays,
  computeWhtrSeries,
  dayMacros,
  eachDay,
  exerciseAdjustment,
  DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL,
  estimateTdee,
  intakeOn,
  latestBmi,
  macroTargets,
  MIN_DAYS_FOR_WEEKLY,
  projectAtCurrentPace,
  projectOnPlan,
  reviewPlan,
  toNumber,
  toNumberOrNull,
  WEEKLY_WINDOW_DAYS,
  windowMacroTotal,
  WHTR_RULE_OF_THUMB,
} from "shared";
import type { Db } from "../db/index.js";
import { getWeightRows, resolveTrend } from "./series.service.js";
import { resolveIntake, resolveMacros } from "./intake.service.js";
import { listMeasurements } from "../repositories/daily.repo.js";
import { findActivePlan } from "../repositories/plans.repo.js";
import { findProfile } from "../repositories/users.repo.js";
import { notFound } from "../lib/errors.js";
import { estimatedKcalOver } from "../repositories/food.repo.js";

/**
 * Assembles the dashboard's numbers.
 *
 * These functions fetch rows and call the shared calc functions. They contain
 * **no formula of their own** — no 7700, no Mifflin coefficients, no coverage
 * arithmetic. If a number here disagreed with the same number in the browser,
 * the whole premise of `packages/shared/src/calc/` would be gone.
 */

/**
 * Today's maintenance figure on its own.
 *
 * The plan endpoints need it to validate against and to record as the baseline
 * a later re-check compares to (D25), and they should not have to assemble the
 * whole insights payload to get it.
 */
export async function currentMaintenance(
  userId: string,
  db: Db,
  asOf?: string,
): Promise<TdeeResult> {
  const day = asOf ?? new Date().toISOString().slice(0, 10);
  const profileRow = await findProfile(userId, db);
  if (!profileRow) throw notFound("This account has no profile row.");

  const [trend, intake, estimatedKcal] = await Promise.all([
    // Both series through their owners (D47). Assembling either here is what
    // produced the two worst bugs in this codebase.
    resolveTrend(userId, db, day),
    resolveIntake(userId, db, {}),
    // How much of what was logged was guessed at (D82). Reported by the result,
    // never used to exclude a day.
    estimatedKcalOver(userId, db, {}),
  ]);

  return estimateTdee({
    trend,
    intake,
    estimatedKcal,
    asOf: day,
    profile: {
      sex: profileRow.sex,
      birthDate: profileRow.birthDate,
      heightCm: toNumberOrNull(profileRow.heightCm),
      activityFactor: toNumber(profileRow.activityFactor),
    },
  });
}

/**
 * The macro block: NNR's derived targets, today's amounts, and the seven-day
 * mean that is the only figure actually compared against a target (D52).
 *
 * No arithmetic of its own beyond picking the override. Every number comes out
 * of `calc/macros.ts`, so the bar the browser draws and the figure the server
 * sends cannot drift.
 */
function assembleMacros(input: {
  targets: MacroTargets;
  overrides: {
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
    fiberG: number | null;
  };
  today: DayMacros;
  window: DayMacros[];
}): MacroTargetsDto {
  const { targets, overrides, today, window } = input;

  const line = (
    key: "protein" | "carbs" | "fat" | "fiber",
    derivedG: number,
    override: number | null,
  ): MacroLineDto => {
    /**
     * Every logged day contributes its **known** grams, and the mean is a floor
     * as soon as one of them was under the gate (D55, addendum 2026-09-15).
     *
     * This used to drop a partial day, on the reasoning that a 40% labelled day
     * would drag the mean down as if intake were low. It would, if the result
     * were stated as a total; stated as "minst", it is exactly as true as the
     * day's own "minst", and dropping it hid a week of real logging whenever the
     * food data was thin, which for fibre is most weeks.
     */
    const weekly = windowMacroTotal(window, key);

    /**
     * Days with **anything at all** on them, which is a fact about the day and
     * not about this macro (D122).
     *
     * `day[key].coverage` is the wrong question and was the first thing tried:
     * a day of six entries that all omit fibre reports fibre coverage 0, which
     * is indistinguishable from a day nobody logged. That is the very
     * distinction the interface is trying to draw, so asking the macro cannot
     * answer it. `kcal` is the day's own total and is non-null exactly when
     * something was logged.
     */
    const daysLogged = window.filter((day) => day.kcal !== null).length;

    return {
      targetG: override ?? derivedG,
      overridden: override !== null,
      derivedG,
      todayG: today[key].grams,
      todayCoverage: today[key].coverage,
      todayComplete: today[key].complete,
      // Below a few days an "average" is one dinner wearing a week's clothes.
      weeklyMeanG: weekly.days >= MIN_DAYS_FOR_WEEKLY ? weekly.meanG : null,
      weeklyDays: weekly.days,
      weeklyComplete: weekly.complete,
      weeklyCoverage: weekly.coverage,
      weeklyPartialDays: weekly.partialDays,
      weeklyDaysLogged: daysLogged,
    };
  };

  return {
    proteinBasis: targets.proteinBasis,
    belowLowEnergyThreshold: targets.belowLowEnergyThreshold,
    protein: line("protein", targets.proteinG, overrides.proteinG),
    carbs: line("carbs", targets.carbsG, overrides.carbsG),
    fat: line("fat", targets.fatG, overrides.fatG),
    fiber: line("fiber", targets.fiberG, overrides.fiberG),
  };
}

export async function getInsights(
  userId: string,
  db: Db,
  asOf: string,
  systemFloorKcal: number = DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL,
): Promise<InsightsResponse> {
  const profileRow = await findProfile(userId, db);
  if (!profileRow) throw notFound("This account has no profile row.");

  /**
   * The seven-day window NNR's values refer to, ending today. Computed from the
   * shared day helper rather than by subtracting from a Date, so it agrees with
   * every other window in the app about what a day is.
   */
  const windowDays = [...eachDay(addDays(asOf, -(WEEKLY_WINDOW_DAYS - 1)), asOf)];

  const [weightRows, trend, intake, plan, measurementRows, macroDays] = await Promise.all([
    getWeightRows(userId, db, {}),
    resolveTrend(userId, db, asOf),
    resolveIntake(userId, db, {}),
    findActivePlan(userId, db),
    listMeasurements(userId, db, {}),
    // Through the owner, like every other read of these two tables (D44, D47).
    resolveMacros(userId, db, { from: windowDays[0], to: asOf }),
  ]);

  const maintenance = estimateTdee({
    trend,
    intake,
    asOf,
    profile: {
      sex: profileRow.sex,
      birthDate: profileRow.birthDate,
      heightCm: toNumberOrNull(profileRow.heightCm),
      activityFactor: toNumber(profileRow.activityFactor),
    },
  });

  const trendWeightKg = trend.at(-1)?.trend ?? null;
  const goalWeightKg = plan ? toNumberOrNull(plan.goalWeightKg) : null;
  const targetIntakeKcal = plan?.targetIntakeKcal ?? null;

  const onPlan =
    trendWeightKg !== null && goalWeightKg !== null && targetIntakeKcal !== null
      ? projectOnPlan({
          currentKg: trendWeightKg,
          goalKg: goalWeightKg,
          tdee: maintenance.tdee,
          targetIntakeKcal,
          asOf,
        })
      : null;

  const atCurrentPace =
    goalWeightKg !== null
      ? projectAtCurrentPace({
          // The smoothed series, not the raw readings — §4.3 regresses the
          // trend, and one dehydrated morning must not move a goal date.
          series: trend.map((point) => ({
            localDate: point.localDate,
            value: point.trend,
          })),
          target: goalWeightKg,
          asOf,
        })
      : null;

  /**
   * The plan was validated once, against a figure designed to change. Re-check
   * it and surface the result; never rewrite it (D25).
   */
  const planReview = plan
    ? reviewPlan({
        targetIntakeKcal: plan.targetIntakeKcal,
        intakeFloorKcal: plan.intakeFloorKcal,
        systemFloorKcal,
        targetRateKgWeek: toNumberOrNull(plan.targetRateKgWeek),
        referenceWeightKg: trendWeightKg,
        currentTdee: maintenance.tdee,
        currentSource: maintenance.source,
        previousTdee: toNumberOrNull(plan.tdeeAtWrite),
        previousSource: (plan.tdeeSourceAtWrite ?? null) as
          | "adaptive"
          | "formula"
          | "none"
          | null,
      })
    : null;

  /**
   * The waist series, smoothed through §4.1 and divided by height (§4.4, D32).
   * Extended to `asOf` so it shares the trend line's axis exactly, and empty
   * when there is no waist history — which is what the chart's toggle checks.
   */
  const whtr = computeWhtrSeries(
    measurementRows
      .filter((row) => row.waistCm !== null)
      .map((row) => ({ localDate: row.localDate, waistCm: toNumber(row.waistCm!) })),
    toNumberOrNull(profileRow.heightCm),
    { to: asOf },
  );

  /**
   * Targets are **derived, never stored** (D52), so they follow the plan without
   * anything having to remember to update them. Null with no plan, because
   * every figure in the block comes from its daily target.
   */
  const targets =
    targetIntakeKcal === null ? null : macroTargets({ targetKcal: targetIntakeKcal, trendWeightKg });

  const macros = targets
    ? assembleMacros({
        targets,
        overrides: {
          proteinG: profileRow.macroProteinG,
          carbsG: profileRow.macroCarbsG,
          fatG: profileRow.macroFatG,
          fiberG: profileRow.macroFiberG,
        },
        today: dayMacros(macroDays.get(asOf) ?? []),
        window: windowDays.map((day) => dayMacros(macroDays.get(day) ?? [])),
      })
    : null;

  const todayIntakeKcal = intakeOn(intake, asOf);

  return {
    asOf,
    maintenance,
    trendWeightKg,
    targetIntakeKcal,
    goalWeightKg,
    projections: { onPlan, atCurrentPace },
    readingCount: weightRows.length,
    planReview,
    systemFloorKcal,
    /**
     * Recomputed from today's source rather than read off the profile row, so
     * a preference set during someone's formula weeks stops applying the day
     * they cross into adaptive — without silently editing their stored setting
     * (D31).
     */
    /**
     * Today's intake, resolved server-side.
     *
     * The dashboard used to read `manual_intake` directly and do its own
     * resolution, which is how it came to disagree with the rest of the app
     * about whether a day had been logged. There is one definition of a day's
     * intake and it is not the client's to hold a second copy of.
     */
    todayIntakeKcal,
    /**
     * Null when nothing is logged, not the whole target. "2 000 kvar" on a day
     * with no food in it is a number that looks like an accounting result and
     * is really an absence, which is the distinction §3 exists to keep.
     */
    todayRemainingKcal:
      targetIntakeKcal === null || todayIntakeKcal === null
        ? null
        : targetIntakeKcal - todayIntakeKcal,
    bmi: latestBmi(trend, toNumberOrNull(profileRow.heightCm)),
    macros,
    exerciseAdjustment: exerciseAdjustment(
      profileRow.addExerciseToTarget,
      maintenance.source,
    ),
    whtr,
    whtrRuleOfThumb: WHTR_RULE_OF_THUMB,
  };
}
