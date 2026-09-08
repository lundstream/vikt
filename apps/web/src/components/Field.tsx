import type { ReactNode } from "react";

/**
 * Label, control, and the message belonging to that control.
 *
 * Errors sit under the field they came from rather than in one lump at the
 * bottom of the form, so "the two passwords do not match" appears where the fix
 * is. Every form from Phase 1 onwards uses this rather than rebuilding the
 * label/error/aria wiring.
 *
 * Pair it with {@link fieldAria}, which produces the matching `aria-invalid`
 * and `aria-describedby` for the control itself:
 *
 * ```tsx
 * <Field id="weight" label="Weight (kg)" error={errors.weightKg} hint="Kilograms.">
 *   <input id="weight" className="field num" {...fieldAria("weight", errors.weightKg, true)} />
 * </Field>
 * ```
 *
 * Note the tone. A validation message is a correction, never a telling-off, and
 * it is set in `--ink` rather than anything red: there is no failure state in
 * this UI (CLAUDE.md §3).
 */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  /** Must match the `id` of the control inside, for the label and the aria ids. */
  id: string;
  label: string;
  error?: string | undefined;
  /** Shown only while there is no error, so the two never stack. */
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-micro text-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-micro text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The aria attributes for the control inside a {@link Field}. Kept as a helper
 * rather than having Field clone its child, so the control stays an ordinary
 * element that can be any tag.
 */
export function fieldAria(
  id: string,
  error: string | undefined,
  hasHint = false,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  if (error) return { "aria-invalid": true, "aria-describedby": `${id}-error` };
  if (hasHint) return { "aria-describedby": `${id}-hint` };
  return {};
}

/** Field name -> the message to show under that field. */
export type FieldErrors = Partial<Record<string, string>>;

/**
 * Collects Zod issues into one message per field. The first issue for a field
 * wins; later ones are usually consequences of it.
 */
export function fieldErrorsFrom(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  return errors;
}
