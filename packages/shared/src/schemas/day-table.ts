import { z } from "zod";

/**
 * `GET /api/day-table` — one row per day, every figure the app keeps (D167).
 *
 * The same rows are the first sheet of `GET /api/export/xlsx`, which is what
 * lets a test say the workbook and the table agree.
 */

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

export const dayTableQuerySchema = z.object({
  /** The first day. Absent means the first day anything was logged. */
  from: localDate.optional(),
  /** The last day, in the person's own timezone, as every other range here. */
  to: localDate,
});
export type DayTableQuery = z.infer<typeof dayTableQuerySchema>;

const macroSchema = z.object({
  grams: z.number().nullable(),
  complete: z.boolean(),
});

export const dayTableRowSchema = z.object({
  localDate: z.string(),
  weightKg: z.number().nullable(),
  trendKg: z.number().nullable(),
  intakeKcal: z.number().nullable(),
  intakeCoverage: z.number().min(0).max(1).nullable(),
  protein: macroSchema,
  carbs: macroSchema,
  fat: macroSchema,
  fiber: macroSchema,
  alcoholUnits: z.number().nullable(),
  activityMinutes: z.number().nullable(),
  steps: z.number().nullable(),
  sleepHours: z.number().nullable(),
  energy: z.number().nullable(),
  mood: z.number().nullable(),
  waistCm: z.number().nullable(),
  maintenanceKcal: z.number().nullable(),
  maintenanceSource: z.enum(["adaptive", "formula"]).nullable(),
  intakeMinusMaintenanceKcal: z.number().nullable(),
});

export const dayTableResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  rows: z.array(dayTableRowSchema),
});
export type DayTableResponse = z.infer<typeof dayTableResponseSchema>;
