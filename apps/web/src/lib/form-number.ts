import { parseDecimal } from "shared";
import { t } from "../i18n/index.js";

/**
 * Reading a number out of a form field.
 *
 * Every numeric input in the app goes through this. `Number()` does not: a
 * Swedish numeric keypad produces a comma, `Number("180,0")` is `NaN`, and the
 * user then sees a validation error on a value they typed correctly.
 *
 * An unparseable value is reported with a reason rather than silently becoming
 * `NaN` and failing a range check further down, which would blame the wrong
 * thing.
 */

export type FieldNumber =
  | { ok: true; value: number }
  | { ok: true; value: null; empty: true }
  | { ok: false; message: string };

export function readNumber(
  input: string,
  { required = false }: { required?: boolean } = {},
): FieldNumber {
  const parsed = parseDecimal(input);

  if (parsed.ok) return { ok: true, value: parsed.value };

  if (parsed.reason === "empty") {
    if (required) return { ok: false, message: t("quick.numberInvalid") };
    return { ok: true, value: null, empty: true };
  }

  if (parsed.reason === "ambiguous") {
    return { ok: false, message: t("quick.numberAmbiguous", { value: input.trim() }) };
  }

  return { ok: false, message: t("quick.numberInvalid") };
}

/** `readNumber` for a required field, collapsing the empty case into an error. */
export function readRequiredNumber(input: string): { ok: true; value: number } | { ok: false; message: string } {
  const result = readNumber(input, { required: true });
  if (!result.ok) return result;
  if (result.value === null) return { ok: false, message: t("quick.numberInvalid") };
  return { ok: true, value: result.value };
}
