import { z } from "zod";

/**
 * Log-writing contracts.
 *
 * Two rules from CLAUDE.md §3 are baked into every shape here:
 *
 * **Idempotent writes.** Every row carries a `clientUuid`, unique per user. The
 * offline queue replays on reconnect and replays are *expected*, so the server
 * upserts on `(user_id, client_uuid)` rather than treating a repeat as an error.
 *
 * **Day boundaries.** The client computes `localDate` from its own timezone and
 * sends it. The server never derives a day bucket from a UTC timestamp — a
 * 23:40 entry in Stockholm is not the same day as the UTC instant, and travel
 * makes it worse.
 */

/** `YYYY-MM-DD`, as computed by the client in its own timezone. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "not a real date");

export const clientUuidSchema = z.string().uuid();

/**
 * Where `localDate` came from (D61).
 *
 * The column has always held two different facts. `device` is §3's rule: the
 * client's own day boundary at the moment of writing, which is why an entry
 * made at 23:50 in Stockholm and synced at 08:00 in Tokyo keeps the Stockholm
 * day (D39). `chosen` is a person filling in last Tuesday, which is not a
 * statement about any clock at all.
 *
 * Optional, and the server stores neither. It exists so the two can be told
 * apart at the boundary rather than after the fact:
 *
 * - a `device` date more than a day from the server's own is a broken client
 *   clock, and no real timezone is further than that from UTC. Saying so at the
 *   boundary beats discovering it as a gap in the series a month later;
 * - a `chosen` date may be any past day, and is refused in the future, because
 *   there is nothing to fill in about a day that has not happened.
 *
 * The offline queue never rewrites either at send time. This is what makes that
 * property checkable rather than merely true.
 */
export const dateSourceSchema = z.enum(["device", "chosen"]);
export type DateSource = z.infer<typeof dateSourceSchema>;

/** Body weight in kg. The range refuses typos, not people. */
export const weightKgSchema = z.number().min(20).max(400);

/**
 * Where a reading came from.
 *
 * `import` marks history backfilled from somewhere else — an old spreadsheet, a
 * previous app. It is not a measurement taken on the day it is filed under, and
 * the chart says so: backfilled history should be visible as backfilled rather
 * than silently indistinguishable from a morning on the scale.
 */
export const weightSourceSchema = z.enum(["manual", "import", "home_assistant"]);
export type WeightSource = z.infer<typeof weightSourceSchema>;

export const createWeightEntrySchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  weightKg: weightKgSchema,
  bodyFatPct: z.number().min(1).max(75).nullish(),
  /** When the reading was taken. Defaults to now if the client omits it. */
  loggedAt: z.string().datetime({ offset: true }).nullish(),
  source: weightSourceSchema.default("manual"),
  note: z.string().trim().max(500).nullish(),
  /**
   * Set by the offline queue, never by a live write (D41).
   *
   * A live write is the user acting on state they can see, so replacing the
   * day's reading is what they asked for. A queued write arrives from the past
   * into a present it has not seen: if another device wrote that day in the
   * meantime, overwriting it silently destroys a reading nobody chose to
   * discard. So a queued write is refused with 409 and the two are put in front
   * of the user instead.
   */
  fromQueue: z.boolean().optional(),
  /** Where `localDate` came from (D61). Checked, never stored. */
  dateSource: dateSourceSchema.optional(),
});
export type CreateWeightEntry = z.infer<typeof createWeightEntrySchema>;

/**
 * Changing a reading that already exists (D150).
 *
 * A separate operation from creating one, and that is the whole point. Editing
 * 24 August from 110,0 to 110,1 used to enqueue a **create** with a fresh
 * `clientUuid`; the server saw a queued write for a day another uuid already
 * held, applied D41's rule correctly, and reported "two devices wrote this
 * day" about one device editing its own reading. The message was right about
 * the rule and wrong about the world, and no wording could have fixed that: the
 * request did not say what it was.
 *
 * So an update carries the row it means and **what the client saw when it
 * opened**. The server applies it when the row still holds that value and
 * refuses only when it does not, which is the one case where somebody's change
 * would be silently thrown away.
 */
export const updateWeightEntrySchema = z.object({
  /** The row being changed. Scoped to the user by the service, as always. */
  id: z.string().uuid(),
  /**
   * The weight the client had on screen before the edit.
   *
   * The conflict baseline, and deliberately the *value* rather than a version
   * column or a timestamp. What matters to the person is whether the number
   * they were looking at is still the number stored; a row rewritten to the
   * same weight by another device is not a conflict worth asking about.
   */
  baselineWeightKg: weightKgSchema,
  weightKg: weightKgSchema,
  bodyFatPct: z.number().min(1).max(75).nullish(),
  note: z.string().trim().max(500).nullish(),
  /**
   * The day the reading should end up on. Usually unchanged; the edit sheet
   * lets it move, and moving onto a day that already has a reading is a real
   * same-day clash rather than a stale baseline.
   */
  localDate: localDateSchema,
  /** Where `localDate` came from (D61). Checked, never stored. */
  dateSource: dateSourceSchema.optional(),
  /**
   * Kept so a queued update is idempotent on replay like every other write
   * (§3). It is **not** used to find the row: `id` does that.
   */
  clientUuid: clientUuidSchema,
  /** Set by the queue, never by a live write. See the create schema. */
  fromQueue: z.boolean().optional(),
});
export type UpdateWeightEntry = z.infer<typeof updateWeightEntrySchema>;

export const weightEntrySchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  localDate: z.string(),
  loggedAt: z.string(),
  weightKg: z.number(),
  bodyFatPct: z.number().nullable(),
  source: weightSourceSchema.catch("manual"),
  note: z.string().nullable(),
});
export type WeightEntry = z.infer<typeof weightEntrySchema>;

/**
 * `from`/`to` are inclusive `localDate` bounds. Both optional: no bounds means
 * the whole series, which is what the "all" range selector asks for.
 */
export const dateRangeQuerySchema = z.object({
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});
export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;

export const weightListSchema = z.object({
  entries: z.array(weightEntrySchema),
});
export type WeightList = z.infer<typeof weightListSchema>;

/**
 * Manual daily intake: one number for the day.
 *
 * Real food logging arrives in phase 3, but the intake series has to start
 * accumulating now because adaptive TDEE (§4.2) is computed from it and needs
 * 28 days of history before it says anything useful.
 */
export const createManualIntakeSchema = z.object({
  clientUuid: clientUuidSchema,
  localDate: localDateSchema,
  kcal: z.number().int().min(0).max(20000),
  proteinG: z.number().int().min(0).max(1000).nullish(),
  note: z.string().trim().max(500).nullish(),
  /** Where `localDate` came from (D61). Checked, never stored. */
  dateSource: dateSourceSchema.optional(),
});
export type CreateManualIntake = z.infer<typeof createManualIntakeSchema>;

export const manualIntakeSchema = z.object({
  id: z.string().uuid(),
  clientUuid: clientUuidSchema,
  localDate: z.string(),
  kcal: z.number(),
  proteinG: z.number().nullable(),
  note: z.string().nullable(),
});
export type ManualIntake = z.infer<typeof manualIntakeSchema>;

export const manualIntakeListSchema = z.object({
  entries: z.array(manualIntakeSchema),
});
export type ManualIntakeList = z.infer<typeof manualIntakeListSchema>;

/**
 * A day's resolved intake, for the data viewer.
 *
 * Resolved **on the server**, by the one function that owns it (D44): the
 * manual row if there is one, otherwise that day's food entries, otherwise
 * absent. The viewer could sum food entries itself and would be wrong in
 * exactly the way four call sites were wrong before D44 — a day logged the
 * other way would read as a day nobody logged.
 *
 * `kcal` is nullable and that nullability is the point. A day with no entry is
 * **absent**, not zero, all the way to the bar that is not drawn for it.
 */
export const intakeDaySchema = z.object({
  localDate: z.string(),
  kcal: z.number().nullable(),
});

export const intakeSeriesSchema = z.object({
  from: z.string(),
  to: z.string(),
  days: z.array(intakeDaySchema),
});
export type IntakeSeries = z.infer<typeof intakeSeriesSchema>;
