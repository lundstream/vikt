import type {
  CreateMilestone,
  CreateOffset,
  CreateSavingsEvent,
  CreateSavingsRule,
  MilestoneDto,
  MilestoneMetricName,
  MilestoneMetric as MilestoneMetricType,
  PotDto,
  PreviewSavingsRule,
  ProgressResponse,
  SavingsRulePreviewDto,
  SavingsRuleDto,
  SavingsEventDto,
  UpdateMilestone,
  UpdateSavingsRule,
} from "shared";
import {
  computeMeasurementSeries,
  computeWhtrSeries,
  currentStreak,
  dayMatchesCadence,
  daysSinceLastDrink,
  daysUntilAffordable,
  checkMilestoneTarget,
  milestoneStatus,
  newlyReached,
  potBalance,
  potSeries,
  potStartDate,
  progressToward,
  metricKind,
  projectAtCurrentPace,
  projectCounted,
  toNumber,
  toNumberOrNull,
  toNumeric,
  toNumericOrNull,
  weeklyRateSek,
  type MilestoneMetric,
  type SavingsRule,
} from "shared";
import type { Db } from "../db/index.js";
import { resolveLoggedDays, resolveTrend } from "./series.service.js";
import { listDailyLogs, listMeasurements } from "../repositories/daily.repo.js";

import { findProfile } from "../repositories/users.repo.js";
import {
  deleteMilestone as deleteMilestoneRow,
  deleteOffset,
  deleteSavingsEvent,
  deleteSavingsRule,
  findMilestone,
  findMilestoneByTarget,
  findSavingsRule,
  findUncelebrated,
  insertMilestone,
  insertSavingsEvent,
  insertSavingsRule,
  listMilestones,
  listOffsets,
  listSavingsEvents,
  listSavingsRules,
  markAchieved,
  markCelebrated,
  markRewardClaimed,
  updateMilestone as updateMilestoneRow,
  updateSavingsRule,
  upsertOffset,
  type MilestoneRow,
  type SavingsEventRow,
  type SavingsRuleRow,
} from "../repositories/progress.repo.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";

/**
 * Milestones, rewards and the savings pot.
 *
 * Every number comes out of `packages/shared/src/calc/`. This file fetches rows
 * and calls those functions; it contains no formula of its own, so the balance
 * the server reports and the balance the browser would compute cannot disagree.
 *
 * The pot is **accrued on read** (D7): summed at query time from rules, offsets
 * and events rather than materialised by a nightly job. A cron would drift and
 * would need backfilling whenever a rule changed retroactively.
 */

/* ------------------------------------------------------ reading the series */

type Series = {
  trendByMetric: Partial<Record<MilestoneMetric, number | null>>;
  rawByMetric: Partial<Record<MilestoneMetric, number | null>>;
  startByMetric: Partial<Record<MilestoneMetric, number | null>>;
  /** The smoothed weight series, for projecting a milestone's date. */
  weightSeries: { localDate: string; value: number }[];
  waistSeries: { localDate: string; value: number }[];
  /** Computed here because two of the metrics *are* these counts. */
  streak: ReturnType<typeof currentStreak>;
  sober: ReturnType<typeof daysSinceLastDrink>;
};

/**
 * Every metric a milestone can target, resolved to its current smoothed value,
 * its latest raw value and the value it started from.
 *
 * The smoothed value is what achievement is judged on; the raw one drives only
 * the "close to it" state (D36).
 */
async function readSeries(userId: string, db: Db, asOf: string): Promise<Series> {
  const [profile, measurementRows, dailyRows, loggedDays, trend] =
    await Promise.all([
    findProfile(userId, db),
    listMeasurements(userId, db, {}),
    listDailyLogs(userId, db, {}),
    resolveLoggedDays(userId, db),
    resolveTrend(userId, db, asOf),
    ]);

  const measurements = measurementRows.map((row) => ({
    localDate: row.localDate,
    waist: toNumberOrNull(row.waistCm),
    chest: toNumberOrNull(row.chestCm),
  }));

  const waist = computeMeasurementSeries(measurements, "waist", { to: asOf });
  const chest = computeMeasurementSeries(measurements, "chest", { to: asOf });

  const whtr = computeWhtrSeries(
    measurementRows
      .filter((row) => row.waistCm !== null)
      .map((row) => ({ localDate: row.localDate, waistCm: toNumber(row.waistCm!) })),
    profile ? toNumberOrNull(profile.heightCm) : null,
    { to: asOf },
  );

  const streak = currentStreak(loggedDays, asOf);

  const sober = daysSinceLastDrink(
    dailyRows.map((row) => ({
      localDate: row.localDate,
      alcoholUnits: toNumberOrNull(row.alcoholUnits),
    })),
    asOf,
    {
      rule: profile?.soberAssumeUnloggedDry ? "assumeSober" : "strict",
      // A run that started before the app did (D44).
      seedLastDrinkOn: profile?.lastDrinkOn ?? null,
    },
  );

  const lastRaw = <T>(points: readonly { raw: T | null }[]): T | null => {
    for (let i = points.length - 1; i >= 0; i--) {
      const value = points[i]!.raw;
      if (value !== null) return value;
    }
    return null;
  };

  return {
    trendByMetric: {
      weight_kg: trend.at(-1)?.trend ?? null,
      waist_cm: waist.at(-1)?.trend ?? null,
      chest_cm: chest.at(-1)?.trend ?? null,
      whtr: whtr.at(-1)?.whtr ?? null,
      // A streak and a dry run are already counts, not noisy measurements:
      // there is nothing to smooth, and the trend and raw values are the same.
      log_streak_days: streak.days,
      sober_days: sober.days,
    },
    rawByMetric: {
      weight_kg: lastRaw(trend),
      waist_cm: lastRaw(waist),
      chest_cm: lastRaw(chest),
      whtr: lastRaw(whtr),
      log_streak_days: streak.days,
      sober_days: sober.days,
    },
    startByMetric: {
      weight_kg: trend[0]?.trend ?? null,
      waist_cm: waist[0]?.trend ?? null,
      chest_cm: chest[0]?.trend ?? null,
      whtr: whtr[0]?.whtr ?? null,
      log_streak_days: 0,
      sober_days: 0,
    },
    weightSeries: trend.map((point) => ({
      localDate: point.localDate,
      value: point.trend,
    })),
    waistSeries: waist.map((point) => ({
      localDate: point.localDate,
      value: point.trend,
    })),
    streak,
    sober,
  };
}

/* ---------------------------------------------------------- the pot itself */

function toRule(row: SavingsRuleRow): SavingsRule {
  return {
    id: row.id,
    label: row.label,
    amountSek: toNumber(row.amountSek),
    cadence: row.cadence,
    startDate: row.startDate,
    endDate: row.endDate,
    active: row.active,
  };
}

function toEventDto(row: SavingsEventRow): SavingsEventDto {
  return {
    id: row.id,
    localDate: row.localDate,
    label: row.label,
    amountSek: toNumber(row.amountSek),
    milestoneId: row.milestoneId,
  };
}

export async function getPot(userId: string, db: Db, asOf: string): Promise<PotDto> {
  const [ruleRows, offsetRows, eventRows] = await Promise.all([
    listSavingsRules(userId, db),
    listOffsets(userId, db),
    listSavingsEvents(userId, db),
  ]);

  const rules = ruleRows.map(toRule);
  const offsets = offsetRows.map((row) => ({
    ruleId: row.ruleId,
    localDate: row.localDate,
  }));
  const events = eventRows.map(toEventDto);

  const balance = potBalance({ rules, offsets, events, asOf });
  const start = potStartDate(rules, events);

  const ruleDtos: SavingsRuleDto[] = rules.map((rule) => {
    const accrual = balance.perRule.find((entry) => entry.ruleId === rule.id);
    return {
      ...rule,
      weeklyRateSek: weeklyRateSek(rule),
      accruedSek: accrual?.accruedSek ?? 0,
      eligibleDays: accrual?.eligibleDays ?? 0,
      offsetDays: accrual?.offsetDays ?? 0,
    };
  });

  return {
    asOf,
    accruedSek: balance.accruedSek,
    eventsSek: balance.eventsSek,
    paidOutSek: balance.paidOutSek,
    balanceSek: balance.balanceSek,
    weeklyRateSek: rules.reduce((total, rule) => total + weeklyRateSek(rule), 0),
    rules: ruleDtos,
    events,
    series:
      start === null || start > asOf
        ? []
        : potSeries({ rules, offsets, events, from: start, to: asOf }),
  };
}

/* ------------------------------------------------------------- milestones */

function toMilestoneDto(
  row: MilestoneRow,
  series: Series,
  pot: PotDto,
  asOf: string,
): MilestoneDto {
  const metric = row.metric as MilestoneMetric;
  const targetValue = toNumber(row.targetValue);
  const trendValue = series.trendByMetric[metric] ?? null;
  const rawValue = series.rawByMetric[metric] ?? null;
  const rewardCostSek = toNumberOrNull(row.rewardCostSek);

  const status = milestoneStatus({
    metric,
    targetValue,
    achievedAt: row.achievedAt?.toISOString() ?? null,
    trendValue,
    rawValue,
  });

  /**
   * Two ways to reach a target, and they need different arithmetic (D79).
   *
   * A **measured** metric is regressed, exactly as the dashboard's goal date is
   * (§4.3), and null is a real answer: sometimes the trend genuinely is not
   * moving. A **counted** metric is not measured at all — a streak advances by
   * one per day, by definition — so its date is subtraction, and reporting that
   * such a series "moves too little for a date" was the app declining to do
   * arithmetic it could do exactly.
   */
  const projection = (() => {
    if (row.achievedAt !== null) return null;

    if (metricKind(metric) === "counted") {
      const current = trendValue ?? rawValue ?? 0;
      return projectCounted({ current, target: targetValue, asOf });
    }

    const projectionSeries =
      metric === "weight_kg"
        ? series.weightSeries
        : metric === "waist_cm"
          ? series.waistSeries
          : null;

    return projectionSeries === null
      ? null
      : projectAtCurrentPace({ series: projectionSeries, target: targetValue, asOf });
  })();

  const affordable =
    rewardCostSek === null ? null : pot.balanceSek >= rewardCostSek;

  return {
    id: row.id,
    label: row.label,
    metric: row.metric as MilestoneMetricName,
    targetValue,
    rewardText: row.rewardText,
    rewardCostSek,
    sortOrder: row.sortOrder,
    achievedAt: row.achievedAt?.toISOString() ?? null,
    achievedValue: toNumberOrNull(row.achievedValue),
    rewardClaimedAt: row.rewardClaimedAt?.toISOString() ?? null,
    status,
    progress: progressToward({
      metric,
      currentValue: trendValue,
      targetValue,
      startValue: series.startByMetric[metric] ?? null,
    }),
    projectedDate: projection?.targetDate ?? null,
    projectedDays: projection?.daysToGoal ?? null,
    rewardAffordable: affordable,
    daysUntilAffordable:
      rewardCostSek === null
        ? null
        : daysUntilAffordable(pot.balanceSek, rewardCostSek, pot.weeklyRateSek),
  };
}

export async function getProgress(
  userId: string,
  db: Db,
  asOf: string,
): Promise<ProgressResponse> {
  const [milestoneRows, pot, uncelebrated, series] = await Promise.all([
    listMilestones(userId, db),
    getPot(userId, db, asOf),
    findUncelebrated(userId, db),
    readSeries(userId, db, asOf),
  ]);

  const milestones = milestoneRows.map((row) => toMilestoneDto(row, series, pot, asOf));

  return {
    asOf,
    streak: series.streak,
    sober: series.sober,
    pot,
    milestones,
    celebrate:
      uncelebrated === null
        ? null
        : (milestones.find((entry) => entry.id === uncelebrated.id) ?? null),
  };
}

/**
 * Detection, run after any write that could move a tracked metric.
 *
 * **Against the trend value, never the raw reading.** One dehydrated morning
 * can put the scale two kilos under where the body is, and a milestone that
 * fires on that is a milestone that fires on nothing. Returns what it stamped
 * so the caller can log it; the celebration is a separate step (D38).
 */
export async function detectMilestones(
  userId: string,
  db: Db,
  asOf: string,
): Promise<MilestoneRow[]> {
  const [rows, series] = await Promise.all([
    listMilestones(userId, db),
    readSeries(userId, db, asOf),
  ]);

  const open = rows.filter((row) => row.achievedAt === null);
  if (open.length === 0) return [];

  const now = new Date();
  const stamped: MilestoneRow[] = [];

  for (const metric of new Set(open.map((row) => row.metric as MilestoneMetric))) {
    const trendValue = series.trendByMetric[metric] ?? null;
    if (trendValue === null) continue;

    const reached = newlyReached(
      open.map((row) => ({
        id: row.id,
        metric: row.metric as MilestoneMetric,
        targetValue: toNumber(row.targetValue),
        achievedAt: row.achievedAt?.toISOString() ?? null,
      })),
      metric,
      trendValue,
    );

    for (const milestone of reached) {
      // `markAchieved` filters on `achieved_at IS NULL`, so a concurrent write
      // that got there first returns null here rather than re-stamping.
      const row = await markAchieved(
        userId,
        db,
        milestone.id,
        toNumeric(trendValue, 2),
        now,
      );
      if (row) stamped.push(row);
    }
  }

  return stamped;
}

/* -------------------------------------------------------------- mutations */

/**
 * The target has to be a plausible figure for its metric.
 *
 * Server-side because the guardrails are (§3): the browser shows the unit and
 * the range, and this is what makes the range true rather than advisory. The
 * message names the band, since "invalid" leaves someone guessing whether they
 * typed the wrong number or picked the wrong metric.
 */
function assertTargetInRange(metric: MilestoneMetricName, targetValue: number): void {
  const checked = checkMilestoneTarget(metric as MilestoneMetricType, targetValue);
  if (checked.ok) return;

  const { min, max, suffix } = checked.unit;
  const unit = suffix === "" ? "" : ` ${suffix}`;
  throw unprocessable(
    "target_out_of_range",
    `Målet ska ligga mellan ${formatBand(min)}${unit} och ${formatBand(max)}${unit}.`,
  );
}

/** Swedish decimal comma, and no trailing ",0" on a whole number. */
function formatBand(value: number): string {
  return String(value).replace(".", ",");
}

export async function createMilestone(
  userId: string,
  db: Db,
  input: CreateMilestone,
): Promise<MilestoneRow> {
  /**
   * One milestone per (metric, target) (D49).
   *
   * Two identical milestones are not two goals, they are one goal entered
   * twice, and the app handles them badly: detection stamps both, and the
   * celebration then fires once for each, because `celebrated_at` is per row
   * and both rows are legitimately uncelebrated. Reaching 100 kg would be
   * announced twice, which reads as a bug in the one moment the product is
   * trying to make feel earned.
   *
   * Different targets on the same metric are the normal case and stay allowed:
   * 100, then 95, then 90.
   */
  assertTargetInRange(input.metric, input.targetValue);

  const existing = await findMilestoneByTarget(
    userId,
    db,
    input.metric,
    toNumeric(input.targetValue, 2),
  );

  if (existing) {
    throw conflict(
      "milestone_exists",
      `Du har redan en milstolpe på det här måttet och målet: "${existing.label}".`,
    );
  }

  return insertMilestone(userId, db, {
    label: input.label,
    metric: input.metric,
    targetValue: toNumeric(input.targetValue, 2),
    rewardText: input.rewardText ?? null,
    rewardCostSek: toNumericOrNull(input.rewardCostSek, 2),
    sortOrder: input.sortOrder ?? 0,
  });
}

export async function editMilestone(
  userId: string,
  db: Db,
  id: string,
  input: UpdateMilestone,
): Promise<MilestoneRow> {
  /**
   * Checked against the metric the row will *end up* with, which is not always
   * the one in the payload: changing only the metric has to be validated
   * against the target already stored, or moving a 95 kg milestone to
   * waist-to-height would save a ratio of 95.
   */
  if (input.metric !== undefined || input.targetValue !== undefined) {
    const current = await findMilestone(userId, db, id);
    if (!current) throw notFound("There is no such milestone.");

    assertTargetInRange(
      (input.metric ?? current.metric) as MilestoneMetricName,
      input.targetValue ?? toNumber(current.targetValue),
    );
  }

  const row = await updateMilestoneRow(userId, db, id, {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.metric !== undefined ? { metric: input.metric } : {}),
    ...(input.targetValue !== undefined
      ? { targetValue: toNumeric(input.targetValue, 2) }
      : {}),
    ...(input.rewardText !== undefined ? { rewardText: input.rewardText ?? null } : {}),
    ...(input.rewardCostSek !== undefined
      ? { rewardCostSek: toNumericOrNull(input.rewardCostSek, 2) }
      : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  });

  if (!row) throw notFound("There is no such milestone.");
  return row;
}

export async function removeMilestone(userId: string, db: Db, id: string): Promise<void> {
  if (!(await deleteMilestoneRow(userId, db, id))) {
    throw notFound("There is no such milestone.");
  }
}

/**
 * Acknowledge the celebration.
 *
 * Its own timestamp, never inferred from `achieved_at`: the whole point is that
 * "achieved" and "already shown" are different facts, and only having both
 * makes a once-only moment possible (D38, §3).
 */
export async function acknowledgeCelebration(
  userId: string,
  db: Db,
  id: string,
): Promise<void> {
  const row = await findMilestone(userId, db, id);
  if (!row) throw notFound("There is no such milestone.");
  await markCelebrated(userId, db, id, new Date());
}

/**
 * Claim a reward: stamp the milestone and draw the pot down by the cost.
 *
 * `reward_claimed_at` is the record of whether it has been paid, and
 * `savings_events.milestone_id` is provenance only — that column is
 * `ON DELETE SET NULL` and D17 names it explicitly as something that must never
 * become the answer to this question.
 *
 * The pot is allowed to go negative as a result. Claiming early is a real
 * choice, and refusing it here would be the app overruling the person whose
 * money it is.
 */
export async function claimReward(
  userId: string,
  db: Db,
  id: string,
  asOf: string,
): Promise<MilestoneRow> {
  const milestone = await findMilestone(userId, db, id);
  if (!milestone) throw notFound("There is no such milestone.");

  if (milestone.achievedAt === null) {
    throw unprocessable(
      "milestone_not_achieved",
      "Den här milstolpen är inte nådd än, så det finns ingen belöning att ta ut.",
    );
  }
  if (milestone.rewardClaimedAt !== null) {
    throw conflict("reward_already_claimed", "Belöningen är redan uttagen.");
  }

  const cost = toNumberOrNull(milestone.rewardCostSek);

  return db.transaction(async (tx) => {
    const claimed = await markRewardClaimed(userId, tx, id, new Date());
    // Null means another request claimed it between the read and the write.
    if (!claimed) throw conflict("reward_already_claimed", "Belöningen är redan uttagen.");

    if (cost !== null && cost > 0) {
      await insertSavingsEvent(userId, tx, {
        localDate: asOf,
        label: milestone.rewardText ?? milestone.label,
        amountSek: toNumeric(-cost, 2),
        milestoneId: milestone.id,
      });
    }

    return claimed;
  });
}

export async function createSavingsRule(
  userId: string,
  db: Db,
  input: CreateSavingsRule,
): Promise<SavingsRuleRow> {
  return insertSavingsRule(userId, db, {
    label: input.label,
    amountSek: toNumeric(input.amountSek, 2),
    cadence: input.cadence,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    active: input.active ?? true,
  });
}

export async function editSavingsRule(
  userId: string,
  db: Db,
  id: string,
  input: UpdateSavingsRule,
): Promise<SavingsRuleRow> {
  const row = await updateSavingsRule(userId, db, id, {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.amountSek !== undefined ? { amountSek: toNumeric(input.amountSek, 2) } : {}),
    ...(input.cadence !== undefined ? { cadence: input.cadence } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.endDate !== undefined ? { endDate: input.endDate ?? null } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
  });

  if (!row) throw notFound("There is no such savings rule.");
  return row;
}

/**
 * What editing or deleting this rule would do to the pot, before it is done.
 *
 * The pot accrues on read (§4.5), which means a rule change is retroactive by
 * construction: move a start date back and months of savings appear, narrow a
 * cadence and they vanish. That is correct behaviour and a surprising one, so
 * it is shown as a number the user confirms.
 *
 * Both balances come from `potBalance` — the same function `getPot` calls, on
 * the same rows — with one rule swapped or removed in memory. Nothing is
 * written, and there is no second implementation of the accrual to disagree
 * with the first.
 */
export async function previewSavingsRule(
  userId: string,
  db: Db,
  id: string,
  input: PreviewSavingsRule,
): Promise<SavingsRulePreviewDto> {
  const [ruleRows, offsetRows, eventRows, milestoneRows] = await Promise.all([
    listSavingsRules(userId, db),
    listOffsets(userId, db),
    listSavingsEvents(userId, db),
    listMilestones(userId, db),
  ]);

  const rules = ruleRows.map(toRule);
  const existing = rules.find((rule) => rule.id === id);
  if (!existing) throw notFound("There is no such savings rule.");

  const offsets = offsetRows.map((row) => ({
    ruleId: row.ruleId,
    localDate: row.localDate,
  }));
  const events = eventRows.map(toEventDto);
  const { asOf, next } = input;

  /**
   * `next === null` is the delete case. The rule is dropped rather than
   * deactivated, because `active: false` stops future accrual and keeps the
   * past, and those are two different answers to "what happens to my pot".
   */
  const nextRules =
    next === null
      ? rules.filter((rule) => rule.id !== id)
      : rules.map((rule) => (rule.id === id ? { ...rule, ...stripUndefined(next) } : rule));

  const before = potBalance({ rules, offsets, events, asOf });
  const after = potBalance({ rules: nextRules, offsets, events, asOf });

  const beforeRule = before.perRule.find((entry) => entry.ruleId === id);
  const afterRule = after.perRule.find((entry) => entry.ruleId === id);

  /**
   * The consequence that is not about money: a reward the pot currently covers
   * and would stop covering. Worth naming, because the pot's whole job is to
   * make a reward reachable, and a rule edit that quietly puts one back out of
   * reach is the kind of thing someone finds out later.
   */
  const claimable = milestoneRows
    .map((row) => toNumberOrNull(row.rewardCostSek))
    .filter((cost): cost is number => cost !== null);

  const wouldUnaffordReward = claimable.some(
    (cost) => before.balanceSek >= cost && after.balanceSek < cost,
  );

  return {
    currentBalanceSek: before.balanceSek,
    nextBalanceSek: after.balanceSek,
    deltaSek: after.balanceSek - before.balanceSek,
    currentRuleAccruedSek: beforeRule?.accruedSek ?? 0,
    nextRuleAccruedSek: afterRule?.accruedSek ?? 0,
    currentEligibleDays: beforeRule?.eligibleDays ?? 0,
    nextEligibleDays: afterRule?.eligibleDays ?? 0,
    wouldUnaffordReward,
  };
}

/** `undefined` means "leave it alone"; spreading it raw would erase the field. */
function stripUndefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * Deleting a rule deletes its history, because there is no history to keep:
 * §4.5 stores no per-day accrual rows, so the rule *is* the record. Its offsets
 * cascade with it.
 *
 * The retroactive effect is why `previewSavingsRule` exists. This function does
 * not enforce that the preview was seen — that is the UI's job, and an API that
 * required a token from a preview call would break the offline queue for a
 * deletion that is perfectly well specified without one.
 */
export async function removeSavingsRule(userId: string, db: Db, id: string): Promise<void> {
  const deleted = await deleteSavingsRule(userId, db, id);
  if (!deleted) throw notFound("There is no such savings rule.");
}

/**
 * File an offset.
 *
 * The rule is looked up **scoped to the caller** before the insert. A rule id
 * is a uuid in a URL, and without this check an offset could be filed against
 * someone else's rule and silently change their pot (§3).
 */
export async function saveOffset(
  userId: string,
  db: Db,
  input: CreateOffset,
): Promise<void> {
  const rule = await findSavingsRule(userId, db, input.ruleId);
  if (!rule) throw notFound("There is no such savings rule.");

  await upsertOffset(userId, db, {
    ruleId: input.ruleId,
    localDate: input.localDate,
    note: input.note ?? null,
  });
}

export async function removeOffset(
  userId: string,
  db: Db,
  ruleId: string,
  localDate: string,
): Promise<void> {
  if (!(await deleteOffset(userId, db, ruleId, localDate))) {
    throw notFound("There is no such offset.");
  }
}

export async function createSavingsEvent(
  userId: string,
  db: Db,
  input: CreateSavingsEvent,
): Promise<SavingsEventDto> {
  const row = await insertSavingsEvent(userId, db, {
    localDate: input.localDate,
    label: input.label,
    amountSek: toNumeric(input.amountSek, 2),
    milestoneId: null,
  });

  return toEventDto(row);
}

export async function removeSavingsEvent(
  userId: string,
  db: Db,
  id: string,
): Promise<void> {
  if (!(await deleteSavingsEvent(userId, db, id))) {
    throw notFound("There is no such savings event.");
  }
}

/** Exported for the offsets the daily screen files inline. */
export async function getOffsetsForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<{ ruleId: string; note: string | null }[]> {
  const rows = await listOffsets(userId, db);
  return rows
    .filter((row) => row.localDate === localDate)
    .map((row) => ({ ruleId: row.ruleId, note: row.note }));
}

/**
 * Rules whose cadence matches a day, so the daily screen can offer an offset
 * for exactly the ones that accrued today and no others.
 *
 * The cadence test is `dayMatchesCadence` from the shared calc package, not a
 * local copy: two implementations of "is this a weekday" would eventually
 * disagree about a Sunday, and the pot would then differ between the screen
 * offering the offset and the sum that applies it.
 */
export async function getRulesForDay(
  userId: string,
  db: Db,
  localDate: string,
): Promise<SavingsRuleDto[]> {
  const pot = await getPot(userId, db, localDate);
  return pot.rules.filter(
    (rule) =>
      rule.active &&
      rule.startDate <= localDate &&
      (rule.endDate === null || rule.endDate >= localDate) &&
      dayMatchesCadence(localDate, rule.cadence),
  );
}
