import { describeDay } from "../lib/dates.js";
import { useLogDate } from "../lib/log-date.js";
import { LOCALE, t } from "../i18n/index.js";

/**
 * Which day this screen is looking at.
 *
 * Dagen and Mat were both hard-wired to today, which made a mistake permanent
 * and a forgotten day unfillable — a UI gap rather than a data one, since both
 * tables have carried `local_date` since phase 1 and every write has been an
 * upsert since then too.
 *
 * Three controls, in the order they are reached for: back a day, the day
 * itself as a picker, forward a day. Forward is **disabled on today** rather
 * than hidden, because a control that vanishes at the edge of its range reads
 * as a rendering bug; there is simply nothing to log about tomorrow.
 *
 * When the day is not today the whole strip says so, and the way back is one
 * tap. That matters more than it looks: the selection is shared with the other
 * screen (D62), so "which day am I writing to" has to be answerable without
 * reading the small print.
 */
export function DateSelector({ label }: { label: string }) {
  const { date, today, setDate, reset, isToday, step } = useLogDate();

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-2 ${
        isToday ? "border-edge" : "border-muted bg-card"
      }`}
      role="group"
      aria-label={label}
    >
      <StepButton
        direction="back"
        label={t("dateSelector.previous")}
        onClick={() => step(-1)}
      />

      {/*
        The readable day **is** the picker.

        There were two controls: a word ("I dag") and a native date field under
        it showing the same day again in the OS's format. One of them was the
        label for the other, which meant the strip carried the date twice and
        the tappable half was the one written in the format the app does not
        use.

        So the native input is stretched over the whole cell and made
        transparent: it keeps the platform's own calendar, its keyboard
        handling and its `max`, while what is *seen* is the Swedish day
        underneath it. `sr-only` is not an option here — a hidden input opens no
        picker — so it is present, sized and invisible.
      */}
      <div className="relative min-w-0 flex-1">
        <span
          aria-hidden="true"
          className="pointer-events-none block py-2 text-center text-note text-ink"
        >
          {describeDay(date, today, LOCALE)}
        </span>
        <input
          type="date"
          data-testid="date-picker"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          value={date}
          max={today}
          onChange={(event) => {
            if (event.target.value) setDate(event.target.value);
          }}
          aria-label={label}
        />
      </div>

      <StepButton
        direction="forward"
        label={t("dateSelector.next")}
        onClick={() => step(1)}
        disabled={isToday}
      />

      {isToday ? null : (
        <button
          type="button"
          data-testid="date-today"
          className="min-h-11 shrink-0 px-2 text-micro text-ink underline underline-offset-4"
          onClick={reset}
        >
          {t("dateSelector.backToToday")}
        </button>
      )}
    </div>
  );
}

function StepButton({
  direction,
  label,
  onClick,
  disabled = false,
}: {
  direction: "back" | "forward";
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={`date-${direction}`}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-11 shrink-0 place-items-center rounded-md text-muted transition-colors hover:text-ink disabled:opacity-30"
    >
      <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
        <path
          d={direction === "back" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
