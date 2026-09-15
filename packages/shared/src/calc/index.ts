/**
 * All derived numbers live here, as pure functions with no I/O, so the server
 * and the client compute identical values from identical inputs. Everything in
 * this directory is covered by Vitest — that is mandatory, see CLAUDE.md §2.
 *
 *   intake.ts         daily intake resolution, shared by TDEE and the UI
 *   trend.ts    §4.1  EMA trend weight                     — done, phase 1
 *   tdee.ts     §4.2  adaptive TDEE with the coverage gate — done, phase 2
 *   project.ts  §4.3  on-plan and current-pace projections — done, phase 2
 *   whtr.ts     §4.4  waist-to-height                      — done, phase 4
 *   measurements.ts   body measurements, smoothed like weight (D32)
 *   activity.ts       MET estimates, kept out of the maths (D33)
 *   correlate.ts      pairing for the scatter view, no statistic (D34)
 *   weekly-intake.ts  intake against trend change, per calendar week (D166)
 *   savings.ts  §4.5  pot balance, accrued on read         — done, phase 5
 *   streak.ts   §4.6  logging streaks, days since a drink  — done, phase 5
 *   habit-streak.ts   one habit's chain, ticked/missed/unknown (D137)
 *   milestone.ts      detection on the trend, never raw    — done, phase 5
 *   macros.ts         macro targets from NNR 2023, derived (D52)
 *   bmi.ts            BMI from the trend weight, never a raw reading
 */

export * from "./trend.js";
export * from "./intake.js";
export * from "./tdee.js";
export * from "./project.js";
export * from "./whtr.js";
export * from "./measurements.js";
export * from "./activity.js";
export * from "./correlate.js";
export * from "./weekly-intake.js";
export * from "./savings.js";
export * from "./streak.js";
export * from "./habit-streak.js";
export * from "./milestone.js";
export * from "./macros.js";
export * from "./bmi.js";
