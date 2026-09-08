import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n/index.js";

/**
 * A panel over the screen: a sheet from the bottom on a phone, a dialog in the
 * middle on a desktop.
 *
 * Extracted from the food screen's portion sheet, which had this markup inline,
 * because the restructure needed the same thing three times and a second copy
 * of a focus trap is a second place to get it wrong.
 *
 * It exists to keep occasional tools **off** the screen without putting them out
 * of reach. The food screen had six blocks competing on one page, and the
 * everyday path — repeat a meal, scan something — was buried among things used
 * once a week. A sheet costs one tap and returns the whole screen.
 *
 * What it does beyond rendering a box:
 *
 *  - **closes on Escape**, because a sheet that can only be dismissed by
 *    hitting a specific button is a trap on a phone;
 *  - **moves focus in on open and back out on close**, so a keyboard or screen
 *    reader user is not left behind on the page underneath;
 *  - **locks the page behind it**, so scrolling the sheet does not scroll the
 *    list underneath it, which on iOS is the difference between a sheet and a
 *    layer of confetti.
 */
export function Sheet({
  open,
  onClose,
  title,
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    returnTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      // Back to the button that opened it, not to the top of the document.
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        className="absolute inset-0 bg-ink/40"
        aria-label={t("quick.cancel")}
        onClick={onClose}
      />

      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        className="relative max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border-t
                   border-edge bg-paper px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5
                   outline-none sm:max-h-[80dvh] sm:rounded-2xl sm:border"
      >
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <button
            type="button"
            className="min-h-11 shrink-0 px-1 text-note text-muted underline underline-offset-4"
            onClick={onClose}
          >
            {t("quick.cancel")}
          </button>
        </div>

        {children}
      </div>
    </div>
  );
}
