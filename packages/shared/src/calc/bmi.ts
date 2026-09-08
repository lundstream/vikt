/**
 * Body mass index, from the trend weight.
 *
 * Its own module rather than a function added to `whtr.ts`, which is where it
 * would naturally sit: that file is an existing calc module and this change was
 * scoped not to touch one. Worth revisiting if a third height-derived index
 * ever appears; two files is not yet a problem worth solving.
 *
 * **From the trend, never the latest reading.** Same reason §4.4 smooths waist
 * before dividing it: a figure computed from one morning moves with hydration,
 * and a number shown to two decimal places beside a category label reads as a
 * measurement rather than an estimate. `latestBmi` takes the trend series and
 * takes its last point, so the caller cannot pass a raw reading by accident.
 *
 * BMI is here because it is the number people already know, not because it is
 * the better one. Waist-to-height is the primary index in §4.4 and stays first
 * on screen; BMI cannot tell muscle from fat and is a population statistic
 * applied to one person. The UI says which is which rather than presenting the
 * pair as equals.
 */

/** The WHO cut-offs, as constants so no component hard-codes 25. */
export const BMI_BANDS = {
  underweight: 18.5,
  normal: 25,
  overweight: 30,
} as const;

export type BmiBand = "underweight" | "normal" | "overweight" | "obese";

/** kg / m². Null rather than wrong when either input is missing. */
export function bmi(weightKg: number | null, heightCm: number | null): number | null {
  if (weightKg === null || heightCm === null) return null;
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm)) return null;
  if (weightKg <= 0 || heightCm <= 0) return null;

  const heightM = heightCm / 100;
  return weightKg / (heightM * heightM);
}

export function bmiBand(value: number | null): BmiBand | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < BMI_BANDS.underweight) return "underweight";
  if (value < BMI_BANDS.normal) return "normal";
  if (value < BMI_BANDS.overweight) return "overweight";
  return "obese";
}

/**
 * BMI from the last point of a smoothed series.
 *
 * Takes the series rather than a number so the smoothing is not something a
 * call site can skip. Every consumer already has the trend to hand.
 */
export function latestBmi(
  trend: readonly { trend: number }[],
  heightCm: number | null,
): number | null {
  return bmi(trend.at(-1)?.trend ?? null, heightCm);
}
