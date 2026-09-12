import { useMemo } from "react";
import { LOCALE, t } from "../i18n/index.js";

/**
 * A month of days, marked where there is something on them (D145).
 *
 * Deliberately knows nothing about weight. It is handed a **set of dates that
 * have data** and a callback, and every string it renders that is not a date
 * comes in as a prop. Dagen's date browsing is the next thing that should use
 * it — a month of days with a daily log on them is the same picture — and it is
 * not wired there in this pass, because a shared component adopted in the same
 * breath as it is written is a component shaped around one caller.
 *
 * The rules it does own:
 *
 * **Weeks start on Monday.** Sweden's do. `Date.getUTCDay()` puts Sunday at 0,
 * so the offset is `(day + 6) % 7`, and getting that wrong shifts the whole
 * grid by one column without erroring.
 *
 * **A day with data is Gran**, the colour that means logged everywhere else in
 * the app (§5), and it is a filled ring rather than a tint so it reads without
 * relying on colour. **Today is Snö** — the text colour, not an accent, because
 * today is not a state anything was logged in.
 *
 * **Every day is a real button.** Not a div with a click handler: that is what
 * makes the grid tabbable, operable with Enter and Space, and visible under
 * `:focus-visible` without anything extra. §5's quality floor asks for keyboard
 * reachability and this is where it is cheapest to honour.
 *
 * **Nothing after `max` is selectable.** There is nothing to record about a day
 * that has not happened, and the server refuses a future `chosen` date anyway
 * (D61); a control that offers it would be offering a refusal.
 */

export type MonthCalendarProps = {
  /** The month on show, `YYYY-MM`. Controlled by the caller. */
  month: string;
  onMonthChange: (month: string) => void;
  /** `YYYY-MM-DD` for every day that has something on it. */
  marked: ReadonlySet<string>;
  /** The account's today, in its own timezone. */
  today: string;
  /** The last selectable day. Defaults to `today`. */
  max?: string;
  onSelect: (localDate: string) => void;
  /**
   * What a marked day is, for the accessible name: "vägning", "dagbok". The
   * component says "12 september, vägning" rather than inventing a noun.
   */
  markedLabel: string;
  /** Names the grid for a screen reader. */
  label: string;
  testId?: string;
};

export function MonthCalendar({
  month,
  onMonthChange,
  marked,
  today,
  max,
  onSelect,
  markedLabel,
  label,
  testId,
}: MonthCalendarProps) {
  const last = max ?? today;
  const days = useMemo(() => monthDays(month), [month]);
  const lead = useMemo(() => leadingBlanks(month), [month]);

  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  /** Hidden rather than disabled: a month that has not happened is not a place. */
  const nextInFuture = `${next}-01` > last;

  return (
    <div data-testid={testId}>
      {/*
        Text links, not chevrons. Two arrow buttons at 24 px are a smaller
        target than the words and say less; the month either side is the thing
        somebody is actually looking for.
      */}
      <div className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          className="min-h-11 px-1 text-note text-muted underline underline-offset-4 hover:text-ink"
          onClick={() => onMonthChange(previous)}
          data-testid="calendar-previous"
        >
          {monthName(previous)}
        </button>

        <h3 className="text-note font-semibold text-ink" aria-live="polite">
          {monthName(month)}
        </h3>

        {nextInFuture ? (
          <span className="min-h-11 px-1" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className="min-h-11 px-1 text-note text-muted underline underline-offset-4 hover:text-ink"
            onClick={() => onMonthChange(next)}
            data-testid="calendar-next"
          >
            {monthName(next)}
          </button>
        )}
      </div>

      <div role="grid" aria-label={label} className="mt-2">
        <div role="row" className="grid grid-cols-7 gap-1">
          {WEEKDAY_KEYS.map((key) => (
            <div
              key={key}
              role="columnheader"
              className="py-1 text-center text-micro text-muted"
            >
              {t(key)}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: lead }, (_, index) => (
            // A blank leading cell is not a day and is not in the tab order.
            <div key={`lead-${index}`} aria-hidden="true" />
          ))}

          {days.map((localDate) => {
            const isMarked = marked.has(localDate);
            const isToday = localDate === today;
            const selectable = localDate <= last;
            /**
             * A string, not a number, and not because of the formatter rule
             * (D26) alone: the stored form is "01", which reads as a padded
             * table cell rather than as the first of the month.
             */
            const dayOfMonth = String(Number(localDate.slice(8)));

            return (
              <button
                key={localDate}
                type="button"
                role="gridcell"
                disabled={!selectable}
                data-testid={`day-${localDate}`}
                data-marked={isMarked ? "true" : undefined}
                aria-label={`${formatDayLong(localDate)}${isMarked ? `, ${markedLabel}` : ""}`}
                onClick={() => onSelect(localDate)}
                className={[
                  "num flex aspect-square min-h-11 items-center justify-center rounded-lg",
                  "text-note transition-colors",
                  // Gran for a day with data, and a ring rather than a fill so
                  // the shape says it too (§5).
                  isMarked
                    ? "border border-logged bg-logged/15 text-logged"
                    : "border border-transparent text-muted",
                  // Today in Snö. Not an accent: today is not a logged state.
                  isToday && !isMarked ? "text-ink" : "",
                  isToday ? "ring-1 ring-inset ring-edge" : "",
                  selectable ? "hover:border-edge" : "cursor-default opacity-40",
                ].join(" ")}
              >
                {dayOfMonth}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Monday first, which is what a Swedish month looks like. */
const WEEKDAY_KEYS = [
  "weekday.mon",
  "weekday.tue",
  "weekday.wed",
  "weekday.thu",
  "weekday.fri",
  "weekday.sat",
  "weekday.sun",
] as const;

/** Every `YYYY-MM-DD` in the month, in order. */
export function monthDays(month: string): string[] {
  const [year, index] = splitMonth(month);
  // Day 0 of the next month is the last day of this one.
  const count = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  return Array.from(
    { length: count },
    (_, day) => `${month}-${String(day + 1).padStart(2, "0")}`,
  );
}

/**
 * Empty cells before the first of the month.
 *
 * `getUTCDay()` is Sunday-first; `(day + 6) % 7` rotates it to Monday-first.
 * Exported because the rotation is the one arithmetic mistake in this file that
 * would look right on about a seventh of all months.
 */
export function leadingBlanks(month: string): number {
  const [year, index] = splitMonth(month);
  return (new Date(Date.UTC(year, index, 1)).getUTCDay() + 6) % 7;
}

/** `YYYY-MM`, `offset` months away. */
export function shiftMonth(month: string, offset: number): string {
  const [year, index] = splitMonth(month);
  const moved = new Date(Date.UTC(year, index + offset, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The `YYYY-MM` a `YYYY-MM-DD` belongs to. */
export function monthOf(localDate: string): string {
  return localDate.slice(0, 7);
}

function splitMonth(month: string): [number, number] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return [year, index];
}

function monthName(month: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function formatDayLong(localDate: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T00:00:00Z`));
}
