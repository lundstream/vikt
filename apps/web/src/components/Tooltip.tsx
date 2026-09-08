import { useId, useState, type ReactNode } from "react";

/**
 * A small "what does this mean" disclosure.
 *
 * A button rather than a hover target: this has to work on a phone, and it has
 * to be reachable by keyboard. Open state is explicit so the text can be read
 * at leisure rather than vanishing when the pointer drifts.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="relative inline-block align-middle">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="ml-1.5 inline-grid h-4 w-4 place-items-center rounded-full border
                   border-edge text-[10px] leading-none text-muted hover:text-ink"
      >
        ?
      </button>

      {open ? (
        <span
          id={id}
          role="note"
          className="absolute left-0 top-6 z-30 block w-64 rounded-lg border border-edge
                     bg-paper p-3 text-micro font-normal leading-relaxed text-muted shadow-sm"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
