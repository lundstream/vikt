import { z } from "zod";

/**
 * `GET /api/correlations` — the deep-dive screen's data.
 *
 * **There is no coefficient in this payload, and that is the contract (D34).**
 *
 * Each pane carries its points, its sample size and the dates it spans, and
 * nothing else. No r, no fitted line, no verdict string. Adding one would mean
 * changing this schema, which is the point: the constraint is written down
 * where a later change has to walk past it.
 *
 * See `calc/correlate.ts` for why — briefly, every pair is one person's
 * self-report over a few weeks with obvious third causes, and a plausible
 * number on this particular screen would get acted on.
 */

export const pairSchema = z.object({
  localDate: z.string(),
  x: z.number(),
  y: z.number(),
});

export const CORRELATION_PANES = [
  "sleep_energy",
  "activity_sweat",
  "intake_trend_change",
] as const;

export const paneSchema = z.object({
  pane: z.enum(CORRELATION_PANES),
  pairs: z.array(pairSchema),
  /** Always rendered next to the chart, never inferred from the point count. */
  sampleSize: z.number().int().min(0),
  /** Days where one axis had a value and the other did not. */
  unpairedDays: z.number().int().min(0),
  range: z.object({ from: z.string(), to: z.string() }).nullable(),
  /** False below `MIN_PAIRS_TO_PLOT`; the UI then says how much more it needs. */
  enough: z.boolean(),
});
export type CorrelationPane = z.infer<typeof paneSchema>;

export const correlationsResponseSchema = z.object({
  asOf: z.string(),
  panes: z.array(paneSchema),
  /** How many paired days a pane needs before it draws anything. */
  minPairs: z.number().int().min(0),
  /** Total days with any daily-log row, for the pre-data copy. */
  dailyLogDays: z.number().int().min(0),
});
export type CorrelationsResponse = z.infer<typeof correlationsResponseSchema>;

export const correlationsQuerySchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .optional(),
});
export type CorrelationsQuery = z.infer<typeof correlationsQuerySchema>;
