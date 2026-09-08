import { sv, type TranslationKey } from "./sv.js";

/**
 * The translation layer. One language, no switcher — DECISIONS.md D21.
 *
 * Deliberately about thirty lines: no plural engine, no lazy loading, no
 * context provider. What it does buy is a single file holding the whole voice
 * of the app, and a missing string that shows up as its own key rather than as
 * blank space.
 */

/** The locale used for every date and number the app formats. */
export const LOCALE = "sv-SE";

export type { TranslationKey };

/**
 * `t("dash.changeOver", { amount: "1.2", days: 30 })`
 *
 * An unknown key returns the key itself. That is conspicuous on screen and easy
 * to assert against, which beats silently rendering nothing.
 */
export function t(
  key: TranslationKey,
  values?: Record<string, string | number>,
): string {
  const template: string = sv[key] ?? key;
  if (!values) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * `t()` for a count, choosing between a singular and a plural key.
 *
 * Not a plural engine: Swedish needs exactly two forms and this is the whole
 * rule. It exists because "1 dagar" has now shipped three times, each time
 * fixed by hand in one string while the next screen reintroduced it.
 *
 *   plural(1, "progress.dayCountOne", "progress.dayCount")  ->  "1 dag"
 */
export function plural(
  count: number,
  one: TranslationKey,
  many: TranslationKey,
  values: Record<string, string | number> = {},
): string {
  return t(count === 1 ? one : many, { ...values, days: count, count });
}

/** Every key, for the completeness test. */
export function translationKeys(): TranslationKey[] {
  return Object.keys(sv) as TranslationKey[];
}
