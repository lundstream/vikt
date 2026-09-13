import { z } from "zod";
import { habitDaySchema } from "./habits.js";
import { ACTIVITY_TYPES } from "../calc/activity.js";
import { MEASUREMENT_RANGE_CM, type MeasurementSite } from "../calc/measurements.js";
import { clientUuidSchema, localDateSchema } from "./log.js";

/**
 * Phase 4 write contracts: body measurements, the daily log and activity.
 *
 * Same two rules as every other log write (CLAUDE.md §3): a `clientUuid` per
 * row so a replay upserts rather than duplicating, and a `localDate` computed
 * by the client, never derived from a UTC timestamp on the server.
 *
 * One rule specific to this phase: **every field is optional**. A day where
 * someone rated their energy and nothing else is a real day, and a form that
 * refuses it teaches people to make up the rest. Absent stays absent all the
 * way through — the correlation view drops a half-logged day rather than
 * filling it in (D34).
 */

/* ------------------------------------------------------------ measurements */

const siteField = (site: MeasurementSite) =>
  z.number().min(MEASUREMENT_RANGE_CM[site].min).max(MEASUREMENT_RANGE_CM[site].max).nullish();

/**
 * The bands refuse typos, not people — a waist of 400 is a slipped decimal
 * point. They live in `calc/measurements.ts` so the form, the API and the chart
 * axis all read the same numbers.
 */
export const createMeasurementSchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  waistCm: siteField("waist"),
  chestCm: siteField("chest"),
  neckCm: siteField("neck"),
  hipsCm: siteField("hips"),
  thighCm: siteField("thigh"),
  armCm: siteField("arm"),
  note: z.string().trim().max(500).nullish(),
});
export type CreateMeasurement = z.infer<typeof createMeasurementSchema>;

export const measurementSchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  localDate: z.string(),
  loggedAt: z.string(),
  waistCm: z.number().nullable(),
  chestCm: z.number().nullable(),
  neckCm: z.number().nullable(),
  hipsCm: z.number().nullable(),
  thighCm: z.number().nullable(),
  armCm: z.number().nullable(),
  note: z.string().nullable(),
});
export type MeasurementEntry = z.infer<typeof measurementSchema>;

export const measurementListSchema = z.object({ entries: z.array(measurementSchema) });
export type MeasurementList = z.infer<typeof measurementListSchema>;

/* -------------------------------------------------------------- daily log */

/** The 1-5 scales. Integers: a slider that lands on 3.5 is a slider, not data. */
const scale = z.number().int().min(1).max(5).nullish();

export const createDailyLogSchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  sweat: scale,
  energy: scale,
  mood: scale,
  hunger: scale,
  /** Hours. 0 is a legitimate, memorable answer. */
  sleepHours: z.number().min(0).max(24).nullish(),
  steps: z.number().int().min(0).max(200000).nullish(),
  /** Swedish standard drinks. Feeds the savings rules and the dry-day counter. */
  alcoholUnits: z.number().min(0).max(50).nullish(),
  note: z.string().trim().max(1000).nullish(),
});
export type CreateDailyLog = z.infer<typeof createDailyLogSchema>;

export const dailyLogSchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  localDate: z.string(),
  loggedAt: z.string(),
  sweat: z.number().nullable(),
  energy: z.number().nullable(),
  mood: z.number().nullable(),
  hunger: z.number().nullable(),
  sleepHours: z.number().nullable(),
  steps: z.number().nullable(),
  alcoholUnits: z.number().nullable(),
  note: z.string().nullable(),
});
export type DailyLogEntry = z.infer<typeof dailyLogSchema>;

export const dailyLogListSchema = z.object({ entries: z.array(dailyLogSchema) });
export type DailyLogList = z.infer<typeof dailyLogListSchema>;

/* --------------------------------------------------------------- activity */

export const activityTypeSchema = z.enum(
  ACTIVITY_TYPES as [string, ...string[]],
);

/**
 * A session. Several a day are normal, so unlike weight and the daily log this
 * has no one-row-per-day index — the uniqueness is on `clientUuid` alone.
 *
 * `kcalEstimate` is **not** accepted from the client. The server computes it
 * from the MET table and the body weight it already has, so the estimate cannot
 * be tampered with and cannot silently disagree between two devices. It is an
 * estimate either way (D33) and it feeds nothing.
 */
export const createActivitySchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  activityType: activityTypeSchema,
  durationMin: z.number().int().min(1).max(1440),
  intensity: z.number().int().min(1).max(5).nullish(),
  note: z.string().trim().max(500).nullish(),
});
export type CreateActivity = z.infer<typeof createActivitySchema>;

export const activitySchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  localDate: z.string(),
  loggedAt: z.string(),
  activityType: z.string(),
  durationMin: z.number(),
  intensity: z.number().nullable(),
  metValue: z.number().nullable(),
  /**
   * A MET estimate, and null when there is no body weight to scale it with.
   * Displayed as an estimate and used in no calculation that feeds maintenance
   * or the projections (D33).
   */
  kcalEstimate: z.number().nullable(),
  note: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof activitySchema>;

export const activityListSchema = z.object({ entries: z.array(activitySchema) });
export type ActivityList = z.infer<typeof activityListSchema>;

/* ------------------------------------------------- the whole day, at once */

/**
 * What the daily screen loads in one request: everything already logged for the
 * day, so the form opens filled in rather than blank. Logging is mostly
 * *amending* — you rate your sleep in the morning and your energy at night —
 * and a blank form on the second visit means retyping or losing the first pass.
 */
export const dayLogSchema = z.object({
  localDate: z.string(),
  daily: dailyLogSchema.nullable(),
  measurement: measurementSchema.nullable(),
  activities: z.array(activitySchema),
  /** Today's weight reading if there is one, so the screen can show it in place. */
  weightKg: z.number().nullable(),
  /**
   * The habit checklist for this day, each row carrying its own answer and its
   * own streak (D137). Part of the day rather than a second request, because
   * the checklist is part of "what happened today" and a screen that loads in
   * two stages ticks in two stages.
   */
  habits: z.array(habitDaySchema),
  /**
   * The savings rules that accrued today, so "I did buy the lunch after all"
   * is part of the same single pass rather than a separate errand (D37). Only
   * rules whose cadence matches today appear, so the list is never a menu of
   * things that did not happen.
   */
  savingsRules: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      amountSek: z.number(),
      offsetToday: z.boolean(),
    }),
  ),
});
export type DayLog = z.infer<typeof dayLogSchema>;
