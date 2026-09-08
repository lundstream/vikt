import { coverageOver, type IntakeIndex } from "./intake.js";
import type { TrendPoint } from "./trend.js";

/**
 * Adaptive TDEE — CLAUDE.md §4.2.
 *
 * Maintenance calories back-calculated from what was actually logged, rather
 * than a formula that never updates (D3). Mifflin-St Jeor is the *fallback*,
 * and "we do not know" is the fallback to that (D20).
 *
 * Pure. No I/O, no clock: `asOf` is passed in.
 */

/** kcal per kg of body mass. An approximation, and the UI says so. */
export const KCAL_PER_KG = 7700;

export const PREFERRED_WINDOW_DAYS = 28;
export const MIN_WINDOW_DAYS = 14;
/** Below this share of days logged, no adaptive figure is returned. */
export const COVERAGE_GATE = 0.8;

/**
 * Even weighting. Coverage governs missing-not-at-random bias plus the variance
 * of the intake mean; window length governs the variance of the trend delta.
 * Under plausible numbers those come out the same order of magnitude, so
 * neither dominates. The full derivation, and why this was 0.7 before, is in
 * DECISIONS.md D19.
 */
export const CONFIDENCE_COVERAGE_WEIGHT = 0.5;
export const CONFIDENCE_LENGTH_WEIGHT = 1 - CONFIDENCE_COVERAGE_WEIGHT;
/** Fixed. Nothing about the user's own data feeds a formula estimate. */
export const FORMULA_CONFIDENCE = 0.25;

export type TdeeSource = "adaptive" | "formula" | "none";

/** A profile field the formula needs and did not get. */
export type MissingInput = "sex" | "birthDate" | "heightCm" | "weightKg";

export type TdeeProfile = {
  sex: "male" | "female" | "unspecified";
  /** `YYYY-MM-DD`, or null when the user has not given one. */
  birthDate: string | null;
  /**
   * Null when the user has not given one (D105).
   *
   * The check below already treated a non-finite height as missing, because
   * D20's whole design is that an absent input is named rather than guessed.
   * This widens the type to say what the runtime already did.
   */
  heightCm: number | null;
  /** Multiplier on BMR for the formula fallback. */
  activityFactor: number;
};

export type TdeeInput = {
  /** From `computeTrend`. Must be in ascending date order. */
  trend: readonly TrendPoint[];
  intake: IntakeIndex;
  profile: TdeeProfile;
  /** The last day of the window, `YYYY-MM-DD`. */
  asOf: string;
  /** Override the preferred window. Tests and nothing else. */
  preferredWindowDays?: number;
  /**
   * How many of the window's logged kcal came from estimated items (D82).
   *
   * Optional, and absent means none, so every caller that predates estimates
   * keeps computing exactly what it computed before.
   */
  estimatedKcal?: number;
};

export type TdeeResult = {
  /** kcal/day, or null when `source` is `"none"`. */
  tdee: number | null;
  source: TdeeSource;
  /** Days actually used. 0 when no window was available. */
  windowDays: number;
  /** Share of the window with intake logged, 0-1. */
  coverage: number;
  /**
   * The share of the window's logged energy that came from estimates (D82).
   *
   * Reported, not gated on. See {@link ESTIMATE_CONFIDENCE_PENALTY} for why an
   * estimated day counts as a logged day and pays in confidence instead.
   */
  estimateShare: number;
  /** 0-1. Shown to the user, never used in arithmetic. See D19. */
  confidence: number;
  /** Profile fields the UI should ask for. Empty unless `source` is `"none"`. */
  missing: MissingInput[];
  /**
   * How many more days of history before an adaptive figure becomes possible,
   * or null when history is not what is holding it up. Lets the pre-data state
   * say what it is waiting for rather than showing a spinner.
   */
  daysUntilAdaptive: number | null;
  /**
   * Why there is no adaptive figure. `"history"` means keep logging and wait;
   * `"coverage"` means the days are there but too many are blank, and waiting
   * will not fix it. Null when the figure *is* adaptive.
   */
  blockedBy: "history" | "coverage" | null;
};

/**
 * The confidence ramp from D19.
 *
 * Monotonic in both arguments; 0 at the worst admissible case; 1.0 only at full
 * coverage across the full preferred window.
 */
export function adaptiveConfidence(
  coverage: number,
  windowDays: number,
  preferredWindowDays: number = PREFERRED_WINDOW_DAYS,
): number {
  // A non-finite input must not leave the other term contributing on its own:
  // clamping NaN to 0 per-term still let a full window report 0.3 confidence
  // off a coverage figure that did not exist.
  if (!Number.isFinite(coverage) || !Number.isFinite(windowDays)) return 0;

  const coverageTerm = clamp01((coverage - COVERAGE_GATE) / (1 - COVERAGE_GATE));
  const lengthSpan = preferredWindowDays - MIN_WINDOW_DAYS;
  const lengthTerm =
    lengthSpan <= 0 ? 1 : clamp01((windowDays - MIN_WINDOW_DAYS) / lengthSpan);

  return clamp01(
    CONFIDENCE_COVERAGE_WEIGHT * coverageTerm + CONFIDENCE_LENGTH_WEIGHT * lengthTerm,
  );
}

/**
 * How much an estimated day costs in confidence (D82).
 *
 * **Estimates count toward coverage.** The alternative — excluding them — drops
 * coverage below the §4.2 gate for anyone who eats out regularly, which loses
 * the adaptive figure entirely and falls back to Mifflin. That is worse, and
 * for the reason the gate itself gives: unlogged days are not a random sample.
 * Restaurant days are precisely the days that differ from the rest, so dropping
 * them recreates the exact bias the gate exists to prevent, only now on purpose.
 *
 * **But they are not free.** Counting them silently would let systematic
 * estimation error walk the maintenance figure somewhere it should not go, with
 * no signal anywhere. §4.2 already has the channel for "this number is real and
 * less certain than usual": confidence, which the UI shows and does not hide.
 * So a window built half out of estimates reports a real figure at reduced
 * confidence rather than no figure at all.
 *
 * 0.5 is a judgement, stated as one: a window made entirely of estimates halves
 * its confidence rather than zeroing it, because an all-estimate window is
 * still a measurement of *something*, and zero would mean "we know nothing",
 * which is not true.
 */
export const ESTIMATE_CONFIDENCE_PENALTY = 0.5;

/** Confidence, reduced in proportion to how much of the window was guessed. */
function withEstimatePenalty(confidence: number, estimateShare: number): number {
  return clamp01(confidence * (1 - ESTIMATE_CONFIDENCE_PENALTY * estimateShare));
}

export function estimateTdee(input: TdeeInput): TdeeResult {
  const preferred = input.preferredWindowDays ?? PREFERRED_WINDOW_DAYS;

  // Only days up to asOf, ascending. The trend series already has one point per
  // day, gaps included, so its length is the number of days of history.
  const history = input.trend.filter((point) => point.localDate <= input.asOf);
  const windowDays = Math.min(preferred, history.length);
  const window = history.slice(history.length - windowDays);
  const dates = window.map((point) => point.localDate);

  const { coverage, totalLoggedKcal, daysWithIntake } = coverageOver(input.intake, dates);

  /**
   * How much of what was logged was guessed at (D82).
   *
   * Supplied by the caller, because only the server can see which entries came
   * from an estimate; zero when nothing said otherwise, which keeps every
   * existing caller meaning what it meant.
   */
  const estimateShare =
    totalLoggedKcal > 0 && input.estimatedKcal !== undefined
      ? clamp01(input.estimatedKcal / totalLoggedKcal)
      : 0;

  const adaptivePossible = windowDays >= MIN_WINDOW_DAYS && coverage >= COVERAGE_GATE;

  if (adaptivePossible) {
    // Intake averages over the days that actually have a log, because an
    // unlogged day is unknown, not zero — dividing by the whole window
    // understated maintenance by exactly the missing fraction, ~18% at the
    // gate (§4.2).
    const meanIntake = totalLoggedKcal / daysWithIntake;

    // The energy term divides by the span the trend actually moved over, which
    // is the first to the last *reading* in the window, not the window's
    // calendar ends. The trend is flat after the last reading because nothing
    // updated it, not because nothing happened; charging those days to the
    // divisor understates the deficit. At a weekly cadence the last reading can
    // sit six days inside the window, so the delta covered 21 of 28 days and
    // maintenance came out 5% light — the same numerator-over-the-wrong-
    // denominator mistake as the intake mean, in the other term.
    const span = trendSpan(window);
    const dailyEnergyKcal =
      span === null ? 0 : (span.deltaKg * KCAL_PER_KG) / span.days;

    const tdee = meanIntake - dailyEnergyKcal;

    return {
      tdee,
      source: "adaptive",
      windowDays,
      coverage,
      estimateShare,
      /**
       * The penalty applies here and only here (D82). A formula figure is not
       * computed from intake at all, so estimates cannot have moved it, and
       * discounting it for their presence would be discounting the wrong number.
       */
      confidence: withEstimatePenalty(
        adaptiveConfidence(coverage, windowDays, preferred),
        estimateShare,
      ),
      missing: [],
      daysUntilAdaptive: null,
      blockedBy: null,
    };
  }

  const latestWeight = latestTrendValue(history);
  const formula = mifflinStJeor({
    profile: input.profile,
    weightKg: latestWeight,
    asOf: input.asOf,
  });

  const blockedBy: "history" | "coverage" =
    windowDays < MIN_WINDOW_DAYS ? "history" : "coverage";
  const daysUntilAdaptive =
    blockedBy === "history" ? MIN_WINDOW_DAYS - windowDays : null;

  if (formula.missing.length > 0) {
    return {
      tdee: null,
      source: "none",
      windowDays,
      coverage,
      estimateShare,
      confidence: 0,
      missing: formula.missing,
      daysUntilAdaptive,
      blockedBy,
    };
  }

  return {
    tdee: formula.tdee! * input.profile.activityFactor,
    source: "formula",
    windowDays,
    coverage,
    estimateShare,
    confidence: FORMULA_CONFIDENCE,
    missing: [],
    daysUntilAdaptive,
    blockedBy,
  };
}

/**
 * Mifflin-St Jeor BMR, before the activity factor.
 *
 *   male:   10*kg + 6.25*cm - 5*age + 5
 *   female: 10*kg + 6.25*cm - 5*age - 161
 *
 * Returns what is missing rather than defaulting anything. "Assume male, assume
 * forty" produces a number that looks real and can be hundreds of kcal wrong,
 * with nothing to tell the user apart from it — see D20.
 */
export function mifflinStJeor(input: {
  profile: Pick<TdeeProfile, "sex" | "birthDate" | "heightCm">;
  weightKg: number | null;
  asOf: string;
}): { tdee: number | null; missing: MissingInput[] } {
  const missing: MissingInput[] = [];

  const { sex, birthDate, heightCm } = input.profile;
  if (sex !== "male" && sex !== "female") missing.push("sex");
  if (!birthDate) missing.push("birthDate");
  if (heightCm === null || !Number.isFinite(heightCm) || heightCm <= 0) missing.push("heightCm");
  if (input.weightKg === null || !Number.isFinite(input.weightKg)) missing.push("weightKg");

  if (missing.length > 0) return { tdee: null, missing };

  const age = ageOn(birthDate!, input.asOf);
  if (age === null) return { tdee: null, missing: ["birthDate"] };

  const offset = sex === "male" ? 5 : -161;
  const bmr = 10 * input.weightKg! + 6.25 * heightCm! - 5 * age + offset;

  return { tdee: bmr, missing: [] };
}

/**
 * The trend movement across a window, measured between the first and last days
 * that carry an actual reading.
 *
 * Null when the window holds fewer than two readings, in which case there is no
 * observed rate of change at all and the energy term contributes nothing rather
 * than a number invented from a flat line.
 */
function trendSpan(
  window: readonly TrendPoint[],
): { deltaKg: number; days: number } | null {
  const measured = window.filter((point) => !point.interpolated);
  const first = measured[0];
  const last = measured[measured.length - 1];
  if (!first || !last || first === last) return null;

  const days =
    (Date.parse(`${last.localDate}T00:00:00Z`) -
      Date.parse(`${first.localDate}T00:00:00Z`)) /
    86_400_000;
  if (!Number.isFinite(days) || days <= 0) return null;

  return { deltaKg: last.trend - first.trend, days };
}

/** Whole years between two `YYYY-MM-DD` dates, or null if either is unparseable. */
export function ageOn(birthDate: string, asOf: string): number | null {
  const born = Date.parse(`${birthDate}T00:00:00Z`);
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(born) || Number.isNaN(now) || born > now) return null;

  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [ay, am, ad] = asOf.split("-").map(Number) as [number, number, number];

  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age;
}

/** The most recent trend value, or null for an empty series. */
function latestTrendValue(history: readonly TrendPoint[]): number | null {
  return history.at(-1)?.trend ?? null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
