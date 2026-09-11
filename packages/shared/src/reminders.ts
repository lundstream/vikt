/**
 * What the two reminders say (D136).
 *
 * Here rather than in either app, because both need the same words and they
 * were briefly in two places: the server builds the notification payload, and
 * the settings screen shows the text before somebody opts in. Two copies of a
 * user-visible string is how one of them ends up being the old one.
 *
 * The app's dictionary still has its own entries, because that is where the
 * copy guards look — the dash rule, sentence case, no shouting — and a string
 * that arrives on a lock screen is interface copy that happens to be displayed
 * somewhere else. `i18n.test.ts` asserts the two agree, so the guards cover the
 * words the server actually sends.
 */
export const REMINDER_TEXT = {
  weigh: "Dags att väga dig",
  day: "Dags att fylla i dagen",
} as const;

/** Where a tap lands. The thing being asked for, not the dashboard behind it. */
export const REMINDER_URL = {
  weigh: "/app/?logga",
  day: "/app/dag",
} as const;

/**
 * What a habit's reminder says (D137).
 *
 * The habit's own name, because the habit's own name is the whole content: the
 * app has nothing to add to "D-vitamin" that is not padding, and a lock screen
 * is the one surface where every extra word costs something.
 *
 * "Kom ihåg" rather than "Du har inte" — §3 has no failure state, and a
 * notification is the worst possible place to invent one.
 */
export function habitReminderBody(name: string): string {
  return `Kom ihåg: ${name}`;
}

/** A habit reminder lands on Dagen, where the checklist is. */
export const HABIT_REMINDER_URL = "/app/dag";
