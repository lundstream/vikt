/**
 * The day boundary, computed once for both sides (D136).
 *
 * CLAUDE.md §3 gives the client the day boundary: it computes `local_date` in
 * the user's timezone and the server stores it untouched. That is still the
 * rule for **logging**, and nothing here changes it.
 *
 * The reminder scheduler is the first thing on the server that has to know
 * what day it is *for somebody else*. It cannot ask the client, because the
 * client is asleep — that is the point of a reminder. So the computation moves
 * here, where both sides use one implementation, rather than being written a
 * second time in the API and drifting from the first.
 *
 * **This one throws on a zone it does not know**, deliberately. The client
 * wraps it and falls back to the device's zone, because an unknown zone must
 * not stop somebody logging. The server must not fall back: the server's zone
 * is not the user's, and quietly substituting UTC would file a reminder under
 * the wrong day and look like it worked. The caller there skips the profile
 * instead.
 */
export function toLocalDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Minutes past midnight in `timezone`.
 *
 * Beside `toLocalDate` because it is the same question asked at a finer grain,
 * and a reminder needs both: which day this is, and how far into it we are.
 */
export function localMinuteOfDay(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Whether a local date is a Saturday or a Sunday (D136, amended).
 *
 * Takes the **date string**, not an instant and a timezone, and that is the
 * whole point: `toLocalDate` has already done the timezone work, and the
 * weekday follows from the calendar date it produced. Asking `Intl` a second
 * time would be a second chance to disagree with the first.
 *
 * Parsed at UTC midnight because the string is a calendar date with no zone of
 * its own. `2026-09-12` is a Saturday for everybody who is having that date,
 * whatever instant it is elsewhere — which is exactly the question being asked.
 *
 * Saturday and Sunday, not a configurable weekend. Somewhere the week ends on a
 * Thursday, and the day that becomes worth building is the day somebody asks.
 */
export function isWeekend(localDate: string): boolean {
  const day = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}
