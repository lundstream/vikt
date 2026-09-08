/**
 * Activity energy from MET values.
 *
 *     kcal = MET * 3.5 * kg / 200 * minutes
 *
 * That is the standard ACSM form: one MET is 3.5 ml O₂ per kg per minute, and
 * a litre of oxygen is about 5 kcal, so `3.5 * kg / 200` is kcal per minute at
 * one MET.
 *
 * **This number is an estimate and is never an input to the maths (D33).**
 *
 * Read that literally. It is not fed into `estimateTdee`, not into either
 * projection, not into the daily intake target. Two reasons, and the second is
 * the one that matters:
 *
 *  1. It is wrong by a lot. MET tables are population averages over a wide
 *     range of body compositions and efficiencies; the same 40-minute run
 *     between two people differs by well over 30%, and the intensity band is a
 *     1-5 guess made after the fact.
 *  2. An adaptive maintenance figure **already contains it**. §4.2 derives
 *     maintenance from what actually happened to the trend line against what
 *     was eaten, so every calorie burned on a run is already in that number.
 *     Adding the run again on top double-counts it (D31) — and unlike an
 *     ordinary estimation error, that one grows with how much you train.
 *
 * So this exists to answer "what did I do this month", to correlate against
 * sweat and energy, and for nothing else. The UI says so in those words.
 *
 * Pure. No I/O, no clock.
 */
import type { TdeeSource } from "./tdee.js";

/**
 * MET by intensity 1-5. Values from the 2011 Compendium of Physical Activities,
 * rounded — a table with two decimals would imply a precision that a
 * self-reported intensity band does not have.
 *
 * Intensity is subjective on purpose. Asking for a heart rate would get either
 * a made-up number or a blank field; asking "how hard was it, 1 to 5" gets an
 * answer, and the answer is about as informative as the table's resolution.
 */
const MET_BANDS: Record<string, readonly [number, number, number, number, number]> = {
  walk: [2.0, 2.8, 3.5, 4.3, 5.0],
  run: [6.0, 7.5, 9.0, 11.0, 13.0],
  cycle: [3.5, 5.5, 7.0, 9.5, 12.0],
  swim: [4.0, 5.5, 7.0, 8.5, 10.0],
  strength: [2.8, 3.5, 5.0, 6.0, 7.0],
  row: [4.0, 6.0, 7.0, 8.5, 12.0],
  ski: [4.5, 6.0, 7.5, 9.0, 12.5],
  football: [5.0, 6.0, 7.0, 8.5, 10.0],
  padel: [4.0, 5.0, 6.0, 7.0, 8.0],
  garden: [2.5, 3.3, 4.0, 5.0, 6.0],
  housework: [2.0, 2.5, 3.3, 4.0, 4.5],
  /** Anything not listed. Deliberately middling and deliberately vague. */
  other: [2.5, 3.5, 4.5, 6.0, 7.5],
};

export const ACTIVITY_TYPES = Object.keys(MET_BANDS) as ActivityType[];

export type ActivityType = keyof typeof MET_BANDS & string;

export function isActivityType(value: string): value is ActivityType {
  return Object.prototype.hasOwnProperty.call(MET_BANDS, value);
}

/** Middle intensity when none was given — the table's own midpoint, not a guess. */
export const DEFAULT_INTENSITY = 3;

/** The MET value for a type at an intensity, falling back to `other`. */
export function metFor(type: string, intensity: number | null | undefined): number {
  const band = MET_BANDS[isActivityType(type) ? type : "other"]!;
  const level = clampIntensity(intensity ?? DEFAULT_INTENSITY);
  return band[level - 1]!;
}

function clampIntensity(value: number): 1 | 2 | 3 | 4 | 5 {
  if (!Number.isFinite(value)) return DEFAULT_INTENSITY as 3;
  const rounded = Math.round(value);
  if (rounded < 1) return 1;
  if (rounded > 5) return 5;
  return rounded as 1 | 2 | 3 | 4 | 5;
}

/**
 * The estimate, rounded to whole kcal.
 *
 * Returns null without a body weight rather than assuming one — the formula is
 * linear in weight, so a default of "75 kg" would be a silent 20% error for
 * plenty of people, and a visibly absent number beats a quietly wrong one (D20,
 * the same rule that governs a missing maintenance figure).
 */
export function activityKcal(input: {
  type: string;
  durationMin: number;
  intensity?: number | null;
  weightKg: number | null;
}): number | null {
  const { durationMin, weightKg } = input;
  if (weightKg === null || !Number.isFinite(weightKg) || weightKg <= 0) return null;
  if (!Number.isFinite(durationMin) || durationMin <= 0) return null;

  const met = metFor(input.type, input.intensity);
  return Math.round(((met * 3.5 * weightKg) / 200) * durationMin);
}

export type ActivityRecord = {
  localDate: string;
  durationMin: number;
  kcalEstimate: number | null;
};

/**
 * Minutes and estimated kcal per day, for the correlation view.
 *
 * Days with no activity are **absent from the map**, not zero — the same rule
 * as intake resolution. "Did not train" and "did not log" are different facts,
 * and only one of them is knowable.
 */
export function buildActivityIndex(
  records: readonly ActivityRecord[],
): Map<string, { minutes: number; kcal: number | null }> {
  const index = new Map<string, { minutes: number; kcal: number | null }>();

  for (const record of records) {
    const existing = index.get(record.localDate) ?? { minutes: 0, kcal: null };
    const kcal =
      record.kcalEstimate === null
        ? existing.kcal
        : (existing.kcal ?? 0) + record.kcalEstimate;

    index.set(record.localDate, {
      minutes: existing.minutes + Math.max(0, record.durationMin),
      kcal,
    });
  }

  return index;
}

/* ------------------------------------------- exercise added to the target */

export type ExerciseAdjustment = {
  /** Whether the toggle can be used at all today. */
  available: boolean;
  /** Whether it is actually raising the target right now. */
  inForce: boolean;
  /** The user's stored preference, kept even while unavailable. */
  preference: boolean;
  reason: "adaptive_includes_activity" | "no_maintenance_figure" | "formula";
};

/**
 * Whether logged exercise may raise today's intake target (D31).
 *
 * **Unavailable, not merely off, whenever maintenance is adaptive.** An adaptive
 * figure is derived from what the trend line actually did against what was
 * actually eaten, so the calories burned training are already inside it. Adding
 * them again is not a preference, it is a double count — and it is a double
 * count that scales with training volume, so the people it hurts most are the
 * ones training hardest. A toggle that merely defaults to off is one tap away
 * from that, with nothing on screen explaining why the tap is wrong.
 *
 * When maintenance comes from the formula it is a different situation. Mifflin
 * times an activity factor is a *baseline* that does not know about today, so
 * adding a specific session to it is a defensible thing to want, and the toggle
 * applies.
 *
 * With no maintenance figure at all (D20) there is nothing to add to.
 *
 * The stored preference is preserved rather than cleared, so someone who set it
 * during their formula weeks does not silently lose it — but it does not come
 * back into force by itself either: `inForce` is recomputed every day from the
 * source in effect that day, and the UI states which case is running.
 */
export function exerciseAdjustment(
  preference: boolean,
  source: TdeeSource,
): ExerciseAdjustment {
  if (source === "adaptive") {
    return {
      available: false,
      inForce: false,
      preference,
      reason: "adaptive_includes_activity",
    };
  }
  if (source === "none") {
    return { available: false, inForce: false, preference, reason: "no_maintenance_figure" };
  }
  return { available: true, inForce: preference, preference, reason: "formula" };
}
