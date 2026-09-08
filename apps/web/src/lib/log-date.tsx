import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { addDays } from "shared";
import { todayLocalDate } from "./dates.js";

/**
 * The day Dagen and Mat are looking at.
 *
 * **Shared between the two screens, for the length of a session, and not
 * persisted** (D62). Three properties, each doing a job:
 *
 * *Shared*, because filling in a past day is one task that spans both screens —
 * you rate Tuesday's sleep and then log Tuesday's dinner — and making the
 * picker forget on every navigation is the reported complaint. Two screens that
 * disagree about "the day" would also be a quiet way to file half a backfill
 * under the wrong date.
 *
 * *Session-scoped and in memory*, because the alternative is worse in the case
 * that matters. A date persisted to storage survives closing the app, so
 * someone who backfilled last Tuesday at midnight would open the app the next
 * morning, log breakfast, and file it under Tuesday. Losing a selection on
 * reload costs two taps; keeping one costs a misfiled day nobody notices.
 *
 * *Self-correcting at midnight*, because a session can outlive a day. If the
 * selection is the day that has just stopped being today, it follows the clock;
 * if it is a deliberate past date, it stays where it was put.
 */

type LogDateValue = {
  /** The day being viewed and written to. */
  date: string;
  /** The client's actual today, recomputed as the app runs. */
  today: string;
  setDate: (next: string) => void;
  /** Back to today, the one control that is always available. */
  reset: () => void;
  isToday: boolean;
  /** Moves by whole days. Never past today: the future is not loggable. */
  step: (days: number) => void;
};

const LogDateContext = createContext<LogDateValue | null>(null);

/** How often the clock is re-read, so a session crossing midnight notices. */
const TICK_MS = 60_000;

export function LogDateProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: ReactNode;
}) {
  const [today, setToday] = useState(() => todayLocalDate(timezone));
  const [date, setDateRaw] = useState(today);

  /**
   * A minute is enough. The alternative — a timer set to the exact boundary —
   * is more code for a case where being sixty seconds late is invisible, and it
   * gets the arithmetic wrong on a device that sleeps through midnight anyway.
   */
  useEffect(() => {
    const tick = () => {
      const now = todayLocalDate(timezone);
      setToday((previous) => {
        if (previous === now) return previous;
        // Only the selection that *was* today follows the clock. A deliberate
        // past date is a decision, and midnight is not a reason to undo it.
        setDateRaw((current) => (current === previous ? now : current));
        return now;
      });
    };

    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [timezone]);

  const setDate = useCallback(
    (next: string) => {
      // Clamped rather than refused: a picker that silently does nothing when
      // you tap tomorrow is indistinguishable from one that is broken.
      setDateRaw(next > today ? today : next);
    },
    [today],
  );

  const value = useMemo<LogDateValue>(
    () => ({
      date,
      today,
      setDate,
      reset: () => setDateRaw(today),
      isToday: date === today,
      step: (days: number) => setDate(addDays(date, days)),
    }),
    [date, today, setDate],
  );

  return <LogDateContext.Provider value={value}>{children}</LogDateContext.Provider>;
}

/**
 * The selected day.
 *
 * Throws outside the provider rather than falling back to today, because a
 * silent fallback is how one screen ends up writing to a different day from the
 * one the user is looking at.
 */
export function useLogDate(): LogDateValue {
  const value = useContext(LogDateContext);
  if (!value) throw new Error("useLogDate used outside LogDateProvider");
  return value;
}
