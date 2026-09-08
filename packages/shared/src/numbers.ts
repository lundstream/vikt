/**
 * The number boundary for user input and display.
 *
 * A Swedish keyboard's numeric pad produces a **comma** as the decimal
 * separator, and `Number("180,0")` is `NaN`. Every numeric field in the app was
 * parsing with `Number()`, so a height typed the way a Swedish phone types it
 * silently became "not a number" and surfaced as a validation error on a value
 * the user had entered correctly.
 *
 * Two functions, no exceptions: {@link parseDecimal} for anything arriving from
 * an input, {@link formatDecimal} for anything going onto the screen. Display
 * and input are separate because they have different jobs — the formatter
 * groups thousands for legibility, and the parser has to accept text that has
 * been grouped, or not, with either separator.
 *
 * Ambiguity is rejected rather than guessed at. "1,234" is one thousand two
 * hundred and thirty-four to an English reader and 1.234 to a Swedish one, and
 * quietly picking one is how a weight becomes a thousand times wrong.
 */

export type ParseResult =
  | { ok: true; value: number }
  | { ok: false; reason: "empty" | "not_a_number" | "ambiguous" };

/**
 * Every character that might be grouping digits: ordinary space, non-breaking
 * space (what `sv-SE` actually emits), narrow no-break space, thin space, and
 * the apostrophe some locales use. Written as escapes rather than literals so
 * they are visible in a diff.
 */
const GROUPING = /[\s\u00a0\u202f\u2009']/g;

/**
 * Parses a number the way a person typed it.
 *
 * Accepts `1234.5`, `1234,5`, `1 234,5`, `1 234.5`, `-0,5`, and the same with
 * non-breaking spaces, which is what `toLocaleString("sv-SE")` emits and what
 * therefore comes back when a field is pre-filled from formatted output.
 *
 * Rejects, rather than guesses:
 *  - `1,234` — could be 1.234 or 1234, and there is no way to tell;
 *  - anything with both separators in an order that contradicts itself;
 *  - anything with more than one decimal separator.
 */
export function parseDecimal(input: string): ParseResult {
  const raw = input.trim();
  if (raw === "") return { ok: false, reason: "empty" };

  const cleaned = raw.replace(GROUPING, "");
  if (!/^[+-]?[\d.,]*\d[\d.,]*$/.test(cleaned)) return { ok: false, reason: "not_a_number" };

  const commas = (cleaned.match(/,/g) ?? []).length;
  const dots = (cleaned.match(/\./g) ?? []).length;

  // Both separators present: the last one is the decimal point, the other is
  // grouping. "1.234,5" and "1,234.5" are both unambiguous.
  if (commas > 0 && dots > 0) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    const decimalSeparator = lastComma > lastDot ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";

    // The grouping separator must not appear after the decimal one, and the
    // groups it makes have to be real groups — "1,5.678" has a comma where a
    // thousands separator cannot go, so it means nothing.
    if (cleaned.lastIndexOf(groupingSeparator) > cleaned.lastIndexOf(decimalSeparator)) {
      return { ok: false, reason: "ambiguous" };
    }

    const [integerPart = "", ...rest] = cleaned.split(decimalSeparator);
    if (!isValidGrouping(integerPart, groupingSeparator)) {
      return { ok: false, reason: "ambiguous" };
    }

    return toNumber(
      `${integerPart.split(groupingSeparator).join("")}.${rest.join("")}`,
    );
  }

  const separator = commas > 0 ? "," : dots > 0 ? "." : null;
  if (separator === null) return toNumber(cleaned);

  const count = commas + dots;
  const parts = cleaned.split(separator);
  const tail = parts[parts.length - 1]!;

  // More than one of the same separator can only be grouping: "1.234.567".
  if (count > 1) {
    if (parts.slice(1).every((part) => part.length === 3)) {
      return toNumber(parts.join(""));
    }
    return { ok: false, reason: "ambiguous" };
  }

  /**
   * One separator and exactly three digits after it is the genuinely ambiguous
   * case — `1,234`. Refuse it rather than pick. Anything else is a decimal
   * point: `1,2`, `82,45`, `1234,5678`.
   */
  if (tail.length === 3 && parts[0] !== "" && /^[+-]?\d{1,3}$/.test(parts[0]!)) {
    return { ok: false, reason: "ambiguous" };
  }

  return toNumber(cleaned.replace(separator, "."));
}

/** `1`, `12`, `123`, `1 234`, `12 345 678` — but not `1 23` or `12 3456`. */
function isValidGrouping(integerPart: string, separator: string): boolean {
  const groups = integerPart.replace(/^[+-]/, "").split(separator);
  if (groups.length === 1) return true;
  const [first, ...tail] = groups;
  if (!first || first.length < 1 || first.length > 3) return false;
  return tail.every((group) => group.length === 3);
}

function toNumber(normalised: string): ParseResult {
  const value = Number(normalised);
  if (!Number.isFinite(value)) return { ok: false, reason: "not_a_number" };
  return { ok: true, value };
}

/**
 * `parseDecimal` with a fallback, for the places that only care whether a value
 * came through. Prefer the full result wherever the reason should be shown.
 */
export function parseDecimalOr(input: string, fallback: number | null): number | null {
  const parsed = parseDecimal(input);
  return parsed.ok ? parsed.value : fallback;
}

export const LOCALE = "sv-SE";

export type FormatOptions = {
  /** Fixed decimals. Omit to let the number decide, up to `maxDecimals`. */
  decimals?: number;
  maxDecimals?: number;
  /** Thousands grouping. On by default; off for a value going into an input. */
  grouping?: boolean;
};

/**
 * The one formatter. Everything the user reads goes through it, so a target of
 * 1700 and a maintenance of 2499 are grouped the same way rather than one of
 * them being a bare `String(n)`.
 */
export function formatDecimal(
  value: number,
  { decimals, maxDecimals = 1, grouping = true }: FormatOptions = {},
): string {
  if (!Number.isFinite(value)) return "—";

  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: decimals ?? 0,
    maximumFractionDigits: decimals ?? maxDecimals,
    useGrouping: grouping,
  }).format(value);
}

/** Whole kcal, grouped: `2 499`. */
export const formatKcal = (value: number): string =>
  formatDecimal(value, { decimals: 0 });

/** One decimal, grouped: `87,3`. */
export const formatKg = (value: number): string =>
  formatDecimal(value, { decimals: 1 });

/**
 * Money, in kronor.
 *
 * Öre appear only when there are any: a pot of 1 200 kr reads as `1 200 kr`,
 * not `1 200,00 kr`, because two zero decimals on every figure make a page of
 * amounts harder to scan for no gain. A negative balance is formatted plainly
 * with a minus, never parenthesised or hidden, because a pot that has been
 * drawn below zero is a fact the user chose and should be able to read.
 *
 * The unit is a suffix rather than `style: "currency"`: the Swedish currency
 * format produces `1 200,00 kr` with mandatory decimals, which is the thing
 * being avoided.
 */
export function formatSek(value: number): string {
  if (!Number.isFinite(value)) return "0 kr";
  const hasOre = Math.abs(value * 100 - Math.round(value * 100)) > 1e-9 ||
    Math.round(value * 100) % 100 !== 0;

  return `${formatDecimal(value, { decimals: hasOre ? 2 : 0 })} kr`;
}

/**
 * A value going *into* a form field.
 *
 * Ungrouped, because a grouping space inside an `<input>` is awkward to edit
 * and some mobile keyboards will not produce one. Still uses the locale's
 * decimal separator, so the field shows `180,0` rather than `180.0` and what
 * the user sees matches what their keyboard makes.
 */
export function formatForInput(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return formatDecimal(value, { decimals, grouping: false });
}
