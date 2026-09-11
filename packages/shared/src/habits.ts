/**
 * The habit checklist's closed sets (D137).
 *
 * Here rather than in the web app because the **server** validates against
 * them. An icon key the API accepts and the client cannot draw is a blank
 * square on somebody's checklist, and one list is the only way to prevent it.
 *
 * The three examples an empty list offers are **not** here: they are copy, they
 * live in the app's register with every other user-visible string, and nothing
 * on the server needs them.
 */

/**
 * The icons a habit may carry.
 *
 * **Closed on purpose.** An open set is an upload endpoint with a content
 * question attached, and the profile's line set is what makes a checklist still
 * look like this app rather than like whatever the phone's emoji keyboard
 * offers. Chosen to cover what people actually put on a list like this: water,
 * a pill, a stretch, a walk, sleep, reading, teeth, daylight, breathing,
 * writing something down.
 *
 * An icon is optional, and a habit with none is just its name. The name is the
 * content; the icon is how you find the row without reading it.
 */
export const HABIT_ICONS = [
  "droppe",
  "tablett",
  "stretch",
  "promenad",
  "somn",
  "bok",
  "tand",
  "sol",
  "andning",
  "penna",
] as const;

export type HabitIcon = (typeof HABIT_ICONS)[number];

export function isHabitIcon(value: string): value is HabitIcon {
  return (HABIT_ICONS as readonly string[]).includes(value);
}

/** The longest a habit's name may be, in the schema and in the field. */
export const HABIT_NAME_MAX = 60;

/**
 * How many habits one account keeps on its checklist.
 *
 * A limit rather than none, because every habit is a row in the day payload and
 * a profile the reminder sweep reads every minute, and because a checklist of
 * forty is not a checklist. Twenty is far past what anybody will write and
 * close enough to say out loud when it is reached.
 */
export const HABIT_MAX = 20;
