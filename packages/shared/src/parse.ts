/**
 * The numeric boundary.
 *
 * Postgres `numeric` columns come back from Drizzle as strings so precision is
 * not silently lost on the way out of the database. Everything above the
 * repository layer works with plain `number`, so every numeric column is parsed
 * here on the way in and serialised here on the way out. See CLAUDE.md §3.
 *
 * Nothing in this file touches I/O. It is pure and unit-testable.
 */

/** Parse a Drizzle `numeric` value into a number. Throws on garbage. */
export function toNumber(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === "") throw new TypeError("empty string is not a number");
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new TypeError(`not a number: ${JSON.stringify(value)}`);
  return parsed;
}

/** Same as {@link toNumber} but passes `null`/`undefined` straight through. */
export function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return toNumber(value);
}

/**
 * Serialise a number for a `numeric` column. Drizzle wants a string, and
 * `toFixed` keeps us from writing `1e-7` into Postgres.
 */
export function toNumeric(value: number, scale: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
  return value.toFixed(scale);
}

/** Same as {@link toNumeric} but passes `null`/`undefined` straight through. */
export function toNumericOrNull(value: number | null | undefined, scale: number): string | null {
  if (value === null || value === undefined) return null;
  return toNumeric(value, scale);
}
