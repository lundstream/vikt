/**
 * The savings pot — CLAUDE.md §4.5.
 *
 *   for each active rule:
 *     eligibleDays = days matching the cadence between start and today
 *     accrued      = eligibleDays * amount
 *     minus offset rows (days you did buy the thing after all)
 *   plus one-off events
 *   minus reward payouts
 *   = balance
 *
 * **Accrued on read, never by cron (D7).** A nightly job that writes rows would
 * drift, would need backfilling whenever a rule changed retroactively, and buys
 * nothing at this data volume: a decade of daily rules is 3,650 iterations of an
 * addition.
 *
 * Money is `numeric` in the database and `number` here, parsed at the boundary
 * (§3). Everything is SEK.
 *
 * Pure. No I/O, no clock — `asOf` is passed in.
 */
import { addDays, eachDay } from "./trend.js";

export type Cadence = "every_day" | "weekday" | "weekend_day" | "per_event";

export type SavingsRule = {
  id: string;
  label: string;
  amountSek: number;
  cadence: Cadence;
  startDate: string;
  /** Inclusive. Null means the rule is still running. */
  endDate: string | null;
  active: boolean;
};

/** A day the rule did not apply, because you did buy the lunch after all. */
export type SavingsOffset = {
  ruleId: string;
  localDate: string;
};

/**
 * A one-off. Reward payouts are these with a **negative** amount, which is what
 * lets the pot be summed in one pass rather than in two with a sign convention
 * to remember.
 */
export type SavingsEvent = {
  id: string;
  localDate: string;
  label: string;
  amountSek: number;
};

/**
 * Whether a day counts for a cadence.
 *
 * `per_event` never accrues by the calendar: it exists for rules like "50 kr
 * every time I skip the Friday beer", where the event is the thing being
 * counted and it arrives as an explicit `savings_event` row. Accruing it daily
 * would invent savings nobody made.
 */
export function dayMatchesCadence(localDate: string, cadence: Cadence): boolean {
  if (cadence === "per_event") return false;
  if (cadence === "every_day") return true;

  // Parsed at UTC midnight so the weekday cannot shift with the host timezone;
  // these strings are already local dates decided by the client (§3).
  const weekday = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  const isWeekend = weekday === 0 || weekday === 6;

  return cadence === "weekend_day" ? isWeekend : !isWeekend;
}

export type RuleAccrual = {
  ruleId: string;
  label: string;
  /** Days the cadence matched, before offsets. */
  eligibleDays: number;
  /** Days cancelled by an offset row. */
  offsetDays: number;
  amountSek: number;
  /** `(eligibleDays - offsetDays) * amountSek`. */
  accruedSek: number;
};

/**
 * What one rule has accrued by `asOf`.
 *
 * Bounded by the rule's own `endDate` as well as by `asOf`, so an ended rule
 * stops growing rather than quietly running forever.
 */
export function accrueRule(
  rule: SavingsRule,
  offsets: readonly SavingsOffset[],
  asOf: string,
): RuleAccrual {
  const base = {
    ruleId: rule.id,
    label: rule.label,
    amountSek: rule.amountSek,
  };

  const end = rule.endDate !== null && rule.endDate < asOf ? rule.endDate : asOf;
  if (!rule.active || end < rule.startDate || rule.cadence === "per_event") {
    return { ...base, eligibleDays: 0, offsetDays: 0, accruedSek: 0 };
  }

  let eligibleDays = 0;
  const eligible = new Set<string>();
  for (const day of eachDay(rule.startDate, end)) {
    if (!dayMatchesCadence(day, rule.cadence)) continue;
    eligibleDays += 1;
    eligible.add(day);
  }

  // An offset only cancels a day the rule would actually have accrued on:
  // an offset filed against a Saturday for a weekday rule is not a deduction,
  // it is a row about a day the rule never counted.
  const offsetDays = offsets.filter(
    (offset) => offset.ruleId === rule.id && eligible.has(offset.localDate),
  ).length;

  return {
    ...base,
    eligibleDays,
    offsetDays,
    accruedSek: (eligibleDays - offsetDays) * rule.amountSek,
  };
}

export type PotBalance = {
  /** What the rules have accrued, net of offsets. */
  accruedSek: number;
  /** One-off additions. */
  eventsSek: number;
  /** Reward payouts, as a positive number for display. */
  paidOutSek: number;
  /**
   * The bottom line, and **allowed to be negative**: claiming a reward before
   * the pot covers it is a real thing people do, and clamping to zero would
   * hide a debt they chose to take on. It renders as a negative number, plainly,
   * not as an error.
   */
  balanceSek: number;
  perRule: RuleAccrual[];
};

export function potBalance(input: {
  rules: readonly SavingsRule[];
  offsets: readonly SavingsOffset[];
  events: readonly SavingsEvent[];
  asOf: string;
}): PotBalance {
  const perRule = input.rules.map((rule) => accrueRule(rule, input.offsets, input.asOf));
  const accruedSek = perRule.reduce((total, rule) => total + rule.accruedSek, 0);

  // Events dated in the future do not count yet. Nothing stops a client sending
  // one, and a pot that includes next month's payout is simply wrong today.
  const dated = input.events.filter((event) => event.localDate <= input.asOf);

  const eventsSek = dated
    .filter((event) => event.amountSek > 0)
    .reduce((total, event) => total + event.amountSek, 0);
  const paidOutSek = dated
    .filter((event) => event.amountSek < 0)
    .reduce((total, event) => total - event.amountSek, 0);

  return {
    accruedSek,
    eventsSek,
    paidOutSek,
    balanceSek: accruedSek + eventsSek - paidOutSek,
    perRule,
  };
}

/**
 * The balance on each day, for the chart that makes the pot visibly climb.
 *
 * Recomputed per day rather than accumulated, which is O(days × rules) and
 * still trivial at this scale, and cannot drift the way a running total can.
 */
export function potSeries(input: {
  rules: readonly SavingsRule[];
  offsets: readonly SavingsOffset[];
  events: readonly SavingsEvent[];
  from: string;
  to: string;
}): { localDate: string; balanceSek: number }[] {
  const points: { localDate: string; balanceSek: number }[] = [];
  for (const day of eachDay(input.from, input.to)) {
    points.push({
      localDate: day,
      balanceSek: potBalance({ ...input, asOf: day }).balanceSek,
    });
  }
  return points;
}

/**
 * The earliest day any rule started, so the series knows where to begin.
 * Null when there are no rules and no events to draw.
 */
export function potStartDate(
  rules: readonly SavingsRule[],
  events: readonly SavingsEvent[],
): string | null {
  const candidates = [
    ...rules.map((rule) => rule.startDate),
    ...events.map((event) => event.localDate),
  ].filter((day) => day !== undefined);

  if (candidates.length === 0) return null;
  return candidates.reduce((min, day) => (day < min ? day : min));
}

/**
 * What a rule adds per week on average, for the copy that says how fast the pot
 * fills. Weekdays and weekend days are counted over a real week rather than
 * assumed to be five and two, so the figure stays right if the cadences change.
 */
export function weeklyRateSek(rule: SavingsRule): number {
  if (!rule.active || rule.cadence === "per_event") return 0;

  let matching = 0;
  // An arbitrary Monday-to-Sunday week; any seven consecutive days contain each
  // weekday exactly once.
  for (const day of eachDay("2026-01-05", "2026-01-11")) {
    if (dayMatchesCadence(day, rule.cadence)) matching += 1;
  }
  return matching * rule.amountSek;
}

/** How many whole days at the current rate until the pot covers `costSek`. */
export function daysUntilAffordable(
  balanceSek: number,
  costSek: number,
  weeklyRate: number,
): number | null {
  if (balanceSek >= costSek) return 0;
  if (weeklyRate <= 0) return null;
  return Math.ceil(((costSek - balanceSek) / weeklyRate) * 7);
}

/** `asOf` plus `days`, for turning the figure above into a date. */
export function dateAfter(asOf: string, days: number): string {
  return addDays(asOf, days);
}
