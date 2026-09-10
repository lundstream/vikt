import type { ReactNode } from "react";
import { Sheet } from "./Sheet.js";
import { t } from "../i18n/index.js";

/**
 * "Are you sure", for the reversible half of the high-impact actions (D123).
 *
 * Two tiers, and this is the lighter one:
 *
 *  - **Irreversible** — deleting an account, deleting somebody else's account,
 *    deleting a backup — requires *typing* something: the address, or the word
 *    RADERA. There is no undo, so the guard is deliberateness, and only typing
 *    proves that somebody read the sheet rather than tapped through it.
 *  - **Reversible** — disabling an account, revoking an unused invite — gets
 *    this. Both undo in one action: enable again, mint another code. Asking
 *    somebody to type an address to do something they can undo in two seconds
 *    is theatre, and theatre teaches people to click past confirmations.
 *
 * A sheet rather than `window.confirm`, because that is what the rest of this
 * app opens things in: it closes on Escape, returns focus, and is styled like
 * the product rather than like the browser.
 *
 * The confirming button carries `btn-impact` — Honung, for the thing with a
 * cost — and the cancel is the ordinary secondary. Cancel is listed second and
 * is not the visually louder of the two: a confirmation whose safe option
 * shouts is one people learn to dismiss without reading.
 */
export function ConfirmSheet({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  busy = false,
  testId,
}: {
  open: boolean;
  title: string;
  /** What the reader needs to know, in a sentence. Usually names the subject. */
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  testId: string;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} testId={testId}>
      <div className="text-body text-muted">{body}</div>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid={`${testId}-confirm`}
          className="btn-impact w-auto px-6"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          data-testid={`${testId}-cancel`}
          className="btn-secondary w-auto px-6"
          onClick={onClose}
        >
          {t("quick.cancel")}
        </button>
      </div>
    </Sheet>
  );
}
