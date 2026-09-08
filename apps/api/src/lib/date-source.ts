import type { DateSource } from "shared";
import { unprocessable } from "./errors.js";

/**
 * Checks a client-supplied `localDate` against where the client says it came
 * from (D61).
 *
 * §3 is unambiguous that the **client owns the day boundary**, and nothing here
 * changes that: the server does not compute a day, does not correct one, and
 * does not store `dateSource`. What it does is notice when the pair is
 * impossible, which is the one thing the server is better placed to see than
 * the client is.
 *
 * The two facts get different bounds because they are different claims:
 *
 * - **`device`** says "this is the day it is, where I am". No timezone is more
 *   than 14 hours ahead of UTC or 12 behind, so a device date is at most one
 *   calendar day either side of the server's. Further than that is a wrong
 *   clock, and a wrong clock silently misfiles every row it writes — the kind
 *   of defect that shows up a month later as a gap in the series.
 * - **`chosen`** says "I am filling in a past day". Any past day is legitimate,
 *   including one from years ago if history is being backfilled. The future is
 *   not: there is nothing to record about a day that has not happened, and
 *   allowing it would put rows beyond `asOf` in every window that reads them.
 *
 * Absent `dateSource` means an older client or a script, and nothing is
 * checked. That is deliberate: the field was added long after the endpoints,
 * and refusing writes that omit it would break the contract to enforce a
 * property that only the newer client can even state.
 */

/**
 * How far a legitimate `device` date can sit from the server's UTC date.
 *
 * One day. UTC+14 (Kiritimati) and UTC-12 (Baker Island) are the extremes, and
 * both are inside a single calendar day of UTC.
 */
export const DEVICE_DATE_SLACK_DAYS = 1;

export function assertDateSource(
  localDate: string,
  dateSource: DateSource | undefined,
  /** The server's own date, injected so this is testable across a boundary. */
  serverDate: string,
): void {
  if (dateSource === undefined) return;

  if (dateSource === "chosen") {
    if (localDate > addUtcDays(serverDate, DEVICE_DATE_SLACK_DAYS)) {
      throw unprocessable(
        "date_in_future",
        "Det går inte att fylla i en dag som inte varit än.",
      );
    }
    return;
  }

  const earliest = addUtcDays(serverDate, -DEVICE_DATE_SLACK_DAYS);
  const latest = addUtcDays(serverDate, DEVICE_DATE_SLACK_DAYS);

  if (localDate < earliest || localDate > latest) {
    throw unprocessable(
      "device_clock_off",
      "Enhetens datum ligger för långt från serverns. Kontrollera klockan, " +
        "eller välj datumet själv om du fyller i en tidigare dag.",
    );
  }
}

/** `YYYY-MM-DD` arithmetic in UTC, which is the only frame the server has. */
function addUtcDays(localDate: string, days: number): string {
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The server's own date, in UTC.
 *
 * The one place the server is allowed to look at a calendar, and it is not used
 * to *file* anything: §3's rule is that day buckets come from the client, and
 * this is only the reference the sanity check above compares against.
 */
export function serverDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
