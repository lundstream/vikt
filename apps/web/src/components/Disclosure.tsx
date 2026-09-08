import { useId, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";

/**
 * A section folded away behind its own heading.
 *
 * §5 asks for one idea per card with space around it, and the two lists this
 * wraps — recent weight readings, recently logged food — are reference material
 * rather than the point of their screens. Folded, they cost a line; open, they
 * are exactly what they were.
 *
 * Rules it keeps:
 *
 *  - **one tap away, not two.** The heading is the control, so there is nothing
 *    to find first;
 *  - **everything inside stays reachable.** Edit and delete live in these
 *    lists, and a disclosure that hid the only route to them would be a
 *    regression dressed as tidying. `hidden` rather than unmounting, so an
 *    in-progress two-tap delete confirm survives a fold;
 *  - **it says what is inside** before you open it, via `summary`. A row count
 *    is what makes the fold safe to leave folded.
 */
export function Disclosure({
  label,
  summary,
  defaultOpen = false,
  testId,
  children,
}: {
  label: string;
  /** A short count or figure, shown beside the label while closed. */
  summary?: string;
  defaultOpen?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <section>
      <h2>
        <button
          type="button"
          data-testid={testId}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="flex min-h-11 w-full items-center justify-between gap-3 text-left
                     text-note text-muted transition-colors hover:text-ink"
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{label}</span>
            {summary ? <span className="num shrink-0 text-micro">{summary}</span> : null}
          </span>

          {/*
            A chevron that rotates, not two different glyphs: the rotation is
            the same affordance every list on a phone uses, and it survives
            being rendered at 11 px.
          */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="sr-only">{open ? t("common.collapse") : t("common.expand")}</span>
        </button>
      </h2>

      <div id={id} hidden={!open} className="pb-1">
        {children}
      </div>
    </section>
  );
}
