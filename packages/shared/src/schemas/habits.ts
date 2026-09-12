import { z } from "zod";
import { HABIT_ICONS, HABIT_NAME_MAX } from "../habits.js";
import { clientUuidSchema, localDateSchema } from "./log.js";

/**
 * The habit checklist over the wire (D137).
 *
 * A habit is a definition; a check is a log row. They are shaped differently on
 * purpose: the definition is created online from a form and answers with its
 * row, the check carries a `client_uuid` and a client-computed `local_date` so
 * the offline queue can replay it like every other log row (§3).
 */

export const habitIconSchema = z.enum(HABIT_ICONS);

/**
 * The reminder fields, in D136's two-time shape.
 *
 * Optional on write and always present on read, so a form can send one switch
 * without restating the other three.
 */
const reminderFields = {
  remind: z.boolean(),
  remindMinute: z.number().int().min(0).max(1439),
  remindWeekend: z.boolean(),
  remindWeekendMinute: z.number().int().min(0).max(1439),
};

/**
 * Creating a habit, **including its reminder** (D142).
 *
 * The reminder fields were only on the update shape, so the create sheet had
 * nothing to send and therefore nothing to offer. One entity, one set of
 * fields: the same form now creates and edits, and both send the same body.
 *
 * Optional and off by default. A notification nobody asked for is the fastest
 * way to have notifications turned off for good.
 */
export const createHabitSchema = z.object({
  name: z.string().trim().min(1).max(HABIT_NAME_MAX),
  icon: habitIconSchema.nullish(),
  remind: reminderFields.remind.optional(),
  remindMinute: reminderFields.remindMinute.optional(),
  remindWeekend: reminderFields.remindWeekend.optional(),
  remindWeekendMinute: reminderFields.remindWeekendMinute.optional(),
});
export type CreateHabit = z.infer<typeof createHabitSchema>;

/**
 * Editing. Every field optional, because the sheet saves one thing at a time:
 * a rename is not a reason to restate a reminder time.
 */
export const updateHabitSchema = z.object({
  name: z.string().trim().min(1).max(HABIT_NAME_MAX).optional(),
  icon: habitIconSchema.nullish(),
  remind: reminderFields.remind.optional(),
  remindMinute: reminderFields.remindMinute.optional(),
  remindWeekend: reminderFields.remindWeekend.optional(),
  remindWeekendMinute: reminderFields.remindWeekendMinute.optional(),
});
export type UpdateHabit = z.infer<typeof updateHabitSchema>;

/** The whole order at once, so a move is one write and cannot half-apply. */
export const reorderHabitsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export type ReorderHabits = z.infer<typeof reorderHabitsSchema>;

export const habitStreakSchema = z.object({
  days: z.number().int().min(0),
  graceUsed: z.number().int().min(0),
  startedOn: z.string().nullable(),
  /** The day the count runs from, which is what the screen names. */
  countingFrom: z.string().nullable(),
  basis: z.enum(["no_data", "gap", "running", "from_first"]),
  checkedToday: z.boolean(),
});
export type HabitStreakWire = z.infer<typeof habitStreakSchema>;

export const habitSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  ...reminderFields,
  createdAt: z.string(),
});
export type Habit = z.infer<typeof habitSchema>;

/** A habit as the day screen needs it: the definition, plus today's answer. */
export const habitDaySchema = habitSchema.extend({
  /** Whether it is ticked on the day being shown. */
  checked: z.boolean(),
  /**
   * Whether the day being shown has an answer for this habit at all. A day
   * answered with no tick is a miss; a day with no row is unknown (D35's
   * distinction, and the streak depends on it).
   */
  answered: z.boolean(),
  streak: habitStreakSchema,
});
export type HabitDay = z.infer<typeof habitDaySchema>;

export const habitListSchema = z.object({ habits: z.array(habitSchema) });
export type HabitList = z.infer<typeof habitListSchema>;

/**
 * Ticking, and unticking.
 *
 * `checked: false` is a write, not a delete: a day answered with no tick is a
 * different fact from a day nobody answered, and only a row can say which.
 */
export const createHabitCheckSchema = z.object({
  clientUuid: clientUuidSchema,
  habitId: z.string().uuid(),
  localDate: localDateSchema,
  checked: z.boolean(),
});
export type CreateHabitCheck = z.infer<typeof createHabitCheckSchema>;

export const habitCheckSchema = z.object({
  id: z.string().uuid(),
  habitId: z.string().uuid(),
  localDate: z.string(),
  checked: z.boolean(),
  streak: habitStreakSchema,
});
export type HabitCheckResult = z.infer<typeof habitCheckSchema>;

/**
 * What happens to the history when a habit is removed.
 *
 * `keep` archives the habit: it leaves the checklist, the ticks stay in the
 * database and in the export, and the row survives because those ticks name it.
 * `remove` is a real delete and takes them with it. The screen says which one
 * it is about to do before it does it.
 */
export const habitDeleteQuerySchema = z.object({
  history: z.enum(["keep", "remove"]).default("keep"),
});
export type HabitDeleteQuery = z.infer<typeof habitDeleteQuerySchema>;
