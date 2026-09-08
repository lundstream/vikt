import { t } from "../i18n/index.js";

/**
 * Local dates, computed on the client.
 *
 * The client owns the day boundary (CLAUDE.md §3): it computes `local_date` in
 * the user's own timezone and sends it, and the server stores it untouched. A
 * weight logged at 23:40 in Stockholm belongs to that day, and deriving it from
 * the UTC instant on the server would file it under tomorrow.
 */

/** `YYYY-MM-DD` for `date` in `timezone`. `en-CA` formats as ISO. */
export function toLocalDate(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    // An unknown zone must not stop someone logging. Fall back to the device's.
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

export function todayLocalDate(timezone: string): string {
  return toLocalDate(new Date(), timezone);
}

/** Short, for axis ticks: `4 Mar`. */
export function formatDayMonth(localDate: string, locale: string): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

/** Long, for tooltips and the entry sheet: `Wednesday 4 March`. */
export function formatLongDay(localDate: string, locale: string): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(date);
}

/** "Today", "Yesterday", or the long form. */
export function describeDay(localDate: string, today: string, locale: string): string {
  if (localDate === today) return t("quick.today");
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (localDate === yesterday) return t("quick.yesterday");
  return formatLongDay(localDate, locale);
}
