import type { CreatePlan, Plan, UpdatePlan } from "shared";
import {
  DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL,
  checkPlanGuardrails,
  impliedRateKgWeek,
  toNumber,
  toNumberOrNull,
  toNumericOrNull,
} from "shared";
import type { Db } from "../db/index.js";
import {
  findActivePlan,
  findPlan,
  insertPlan,
  listPlans,
  updatePlan as updatePlanRow,
  type PlanRow,
} from "../repositories/plans.repo.js";
import { getWeightRows } from "./series.service.js";
import { notFound, unprocessable } from "../lib/errors.js";

/**
 * Plans, and the guardrails from CLAUDE.md §3.
 *
 * Phase 2 owns what a plan is *for* — adaptive TDEE, projections, the numbers on
 * the dashboard. What lives here now is the row plus the two server-side
 * guardrails, because those are non-negotiable and an endpoint that can write a
 * plan they forbid is worse than no endpoint.
 *
 * Rejections are 422 with the message the user should read, not a generic
 * validation blob.
 */

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    startWeightKg: toNumberOrNull(row.startWeightKg),
    goalWeightKg: toNumberOrNull(row.goalWeightKg),
    targetIntakeKcal: row.targetIntakeKcal,
    targetRateKgWeek: toNumberOrNull(row.targetRateKgWeek),
    proteinFloorG: row.proteinFloorG,
    intakeFloorKcal: row.intakeFloorKcal,
    tdeeAtWrite: toNumberOrNull(row.tdeeAtWrite),
    tdeeSourceAtWrite: (row.tdeeSourceAtWrite ?? null) as Plan["tdeeSourceAtWrite"],
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The weight the 1%-per-week cap is measured against: the plan's own starting
 * weight if it has one, else the latest logged reading. Null when there is
 * neither, in which case the rate check cannot run and is skipped rather than
 * guessed at.
 */
async function referenceWeightKg(
  userId: string,
  db: Db,
  startWeightKg: number | null | undefined,
): Promise<number | null> {
  if (startWeightKg != null) return startWeightKg;

  const rows = await getWeightRows(userId, db, {});
  const latest = rows.at(-1);
  return latest ? toNumber(latest.weightKg) : null;
}

/**
 * The rate a target implies, derived rather than stored as intent (D27).
 * Null when there is no maintenance figure to derive it from.
 */
function derivedRate(targetIntakeKcal: number, tdee: number | null | undefined) {
  if (tdee === null || tdee === undefined || !Number.isFinite(tdee)) return null;
  return impliedRateKgWeek(tdee, targetIntakeKcal);
}

async function assertGuardrails(
  userId: string,
  db: Db,
  candidate: {
    targetIntakeKcal: number;
    intakeFloorKcal: number;
    startWeightKg?: number | null;
  },
  systemFloorKcal: number,
  tdee: number | null | undefined,
): Promise<void> {
  const weightKg = await referenceWeightKg(userId, db, candidate.startWeightKg);
  const readings = await getWeightRows(userId, db, {});

  const violations = checkPlanGuardrails({
    targetIntakeKcal: candidate.targetIntakeKcal,
    intakeFloorKcal: candidate.intakeFloorKcal,
    systemFloorKcal,
    hasWeightReading: readings.length > 0,
    // The rate the plan will actually produce, not a number typed beside it.
    targetRateKgWeek: derivedRate(candidate.targetIntakeKcal, tdee),
    referenceWeightKg: weightKg,
  });

  if (violations.length === 0) return;

  // The first violation's code, so the client can tell the system floor from
  // the user's own — they have different remedies (D24).
  throw unprocessable(
    violations[0]!.code,
    violations.map((violation) => violation.message).join(" "),
  );
}

export type PlanContext = {
  systemFloorKcal?: number;
  /** Current maintenance, recorded so a later re-check has a baseline (D25). */
  tdee?: number | null;
  tdeeSource?: "adaptive" | "formula" | "none" | null;
};

export async function createPlan(
  userId: string,
  db: Db,
  input: CreatePlan,
  context: PlanContext = {},
): Promise<Plan> {
  const systemFloorKcal = context.systemFloorKcal ?? DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL;
  await assertGuardrails(userId, db, input, systemFloorKcal, context.tdee);

  const row = await insertPlan(userId, db, {
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    startWeightKg: toNumericOrNull(input.startWeightKg, 2),
    goalWeightKg: toNumericOrNull(input.goalWeightKg, 2),
    targetIntakeKcal: input.targetIntakeKcal,
    targetRateKgWeek: toNumericOrNull(derivedRate(input.targetIntakeKcal, context.tdee), 2),
    proteinFloorG: input.proteinFloorG ?? null,
    intakeFloorKcal: input.intakeFloorKcal,
    tdeeAtWrite: toNumericOrNull(context.tdee ?? null, 1),
    tdeeSourceAtWrite: context.tdeeSource ?? null,
  });

  return toPlan(row);
}

export async function editPlan(
  userId: string,
  db: Db,
  planId: string,
  input: UpdatePlan,
  context: PlanContext = {},
): Promise<Plan> {
  const existing = await findPlan(userId, db, planId);
  if (!existing) throw notFound("No such plan.");

  // Guardrails run against the plan as it would be *after* the edit, not
  // against the fields that happen to be in this request.
  const merged = {
    targetIntakeKcal: input.targetIntakeKcal ?? existing.targetIntakeKcal,
    intakeFloorKcal: input.intakeFloorKcal ?? existing.intakeFloorKcal,
    startWeightKg:
      input.startWeightKg !== undefined
        ? input.startWeightKg
        : toNumberOrNull(existing.startWeightKg),
  };
  await assertGuardrails(
    userId,
    db,
    merged,
    context.systemFloorKcal ?? DEFAULT_SYSTEM_INTAKE_FLOOR_KCAL,
    context.tdee,
  );

  const row = await updatePlanRow(userId, db, planId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.endDate !== undefined ? { endDate: input.endDate ?? null } : {}),
    ...(input.startWeightKg !== undefined
      ? { startWeightKg: toNumericOrNull(input.startWeightKg, 2) }
      : {}),
    ...(input.goalWeightKg !== undefined
      ? { goalWeightKg: toNumericOrNull(input.goalWeightKg, 2) }
      : {}),
    ...(input.targetIntakeKcal !== undefined
      ? { targetIntakeKcal: input.targetIntakeKcal }
      : {}),
    // Always recomputed: the rate is derived, so it is re-derived on every save.
    targetRateKgWeek: toNumericOrNull(
      derivedRate(merged.targetIntakeKcal, context.tdee),
      2,
    ),
    ...(input.proteinFloorG !== undefined
      ? { proteinFloorG: input.proteinFloorG ?? null }
      : {}),
    ...(input.intakeFloorKcal !== undefined
      ? { intakeFloorKcal: input.intakeFloorKcal }
      : {}),
    // Editing re-baselines the plan: it has just been checked against this.
    tdeeAtWrite: toNumericOrNull(context.tdee ?? null, 1),
    tdeeSourceAtWrite: context.tdeeSource ?? null,
  });

  if (!row) throw notFound("No such plan.");
  return toPlan(row);
}

export async function getPlans(userId: string, db: Db): Promise<Plan[]> {
  const rows = await listPlans(userId, db);
  return rows.map(toPlan);
}

export async function getActivePlan(userId: string, db: Db): Promise<Plan | null> {
  const row = await findActivePlan(userId, db);
  return row ? toPlan(row) : null;
}
