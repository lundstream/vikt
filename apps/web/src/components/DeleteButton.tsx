import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";

/**
 * Removing a log row.
 *
 * Immediate, unlike a photo (D10): a log row is small, replaceable and entirely
 * the user's, and a modal on every mistyped weight is friction on the recovery
 * path rather than on the destructive one.
 *
 * Immediate is not the same as unannounced, though, and the brief for this is
 * that it be **reachable and obvious what will happen**. So it is a two-tap
 * control: the first tap replaces the label with what is about to be removed,
 * the second does it. That costs one tap, states the consequence in the place
 * the eye already is, and cannot fire from a pocket.
 *
 * The armed state times out. A confirm left showing from ten minutes ago is a
 * trap for the next person to pick the phone up.
 */
const ARMED_MS = 4000;

export function DeleteButton({
  onDelete,
  /** What is about to go, named. "Ta bort 87,4 kg?" beats "Är du säker?". */
  label,
  testId,
}: {
  onDelete: () => void | Promise<unknown>;
  label: string;
  testId?: string;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), ARMED_MS);
    return () => window.clearTimeout(timer.current);
  }, [armed]);

  return (
    <button
      type="button"
      data-testid={testId}
      // A real target rather than bare text: 44 px is what a thumb actually
      // hits, and this sits in a dense list where the neighbours are taps too.
      className={[
        "-mr-2 flex min-h-11 shrink-0 items-center rounded-md px-2 text-micro underline underline-offset-4",
        armed ? "text-ink" : "text-muted",
      ].join(" ")}
      aria-label={armed ? t("delete.confirmAria", { what: label }) : t("delete.aria", { what: label })}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void onDelete();
      }}
    >
      {armed ? t("delete.confirm") : t("delete.action")}
    </button>
  );
}
