import { Link } from "react-router-dom";
import { useQueueState } from "../lib/queue/useQueue.js";
import { plural, t } from "../i18n/index.js";

/**
 * The sync indicator.
 *
 * Visible when something is pending, invisible when everything is clean. That
 * is the whole specification and it rules out the obvious alternative: a green
 * tick saying "synced", which is a permanent piece of furniture that says
 * nothing on the overwhelming majority of loads.
 *
 * It is also not a failure state (§3). A pending entry is not an error, it is a
 * thing that has been saved and not yet sent, so it renders in `--muted` like
 * any other note, never in red and never with a warning glyph. Only something
 * that actually needs a person gets weight, and even then it is a link, not an
 * alarm.
 */
export function SyncIndicator() {
  const { pending, attention } = useQueueState();

  if (pending === 0 && attention === 0) return null;

  return (
    <Link
      to="/installningar"
      data-testid="sync-indicator"
      className="text-micro text-muted underline underline-offset-4"
    >
      {attention > 0
        ? plural(attention, "sync.needsYouOne", "sync.needsYou")
        : plural(pending, "sync.pendingOne", "sync.pending")}
    </Link>
  );
}

/**
 * The offline notice, for screens whose numbers cannot be computed without the
 * server (D43).
 *
 * Says which parts still work rather than only what does not, because "you are
 * offline" on its own reads as "nothing works", and logging is exactly what
 * does work.
 */
export function OfflineNotice({
  what,
}: {
  what: "insights" | "correlations" | "progress" | "data";
}) {
  return (
    <p role="status" className="max-w-prose text-note text-muted">
      {t(`offline.${what}` as "offline.insights")}{" "}
      {t("offline.loggingStillWorks")}
    </p>
  );
}
