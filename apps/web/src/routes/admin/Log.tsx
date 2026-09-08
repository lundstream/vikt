import { formatLongDay } from "../../lib/dates.js";
import { LOCALE, t, translationKeys, type TranslationKey } from "../../i18n/index.js";
import { useAdminLog } from "./api.js";

/**
 * The audit log (D95, D100).
 *
 * Every mutating admin action writes a row, from inside the service rather than
 * the route, so there is no path that does the thing without recording it. This
 * is the screen that makes that worth having: a log nobody can read is a log
 * that exists for an audit that will never happen.
 *
 * The row keeps a snapshot of the actor's address alongside the foreign key,
 * which is why an entry stays readable after that account is deleted. Deleting
 * an admin does not erase what they did.
 */
export function Log() {
  const log = useAdminLog();

  if (log.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const entries = log.data?.entries ?? [];

  return (
    <section data-testid="admin-log">
      <p className="mb-4 max-w-prose text-note text-muted">{t("admin.logWhat")}</p>

      {entries.length === 0 ? (
        <p className="text-note text-muted">{t("admin.noLog")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {entries.map((entry) => (
            <li key={entry.id} className="py-3" data-testid={`log-${entry.id}`}>
              <p className="text-note text-ink">
                <span className="text-muted">{entry.actorEmail}</span> {describe(entry.action)}
                {entry.detail ? <span className="text-muted"> {entry.detail}</span> : null}
              </p>
              <p className="num mt-0.5 text-micro text-muted">
                {formatLongDay(entry.createdAt.slice(0, 10), LOCALE)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The action, in words, falling back to the raw string.
 *
 * A new action added to the service without a key here renders as
 * `invite.something` rather than as a blank line. That is ugly on purpose: it is
 * legible enough to act on and obviously unfinished, which is what an untranslated
 * audit entry should look like.
 */
function describe(action: string): string {
  const key = `admin.action.${action}` as TranslationKey;
  return translationKeys().includes(key) ? t(key) : action;
}
