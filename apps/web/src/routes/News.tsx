import { useEffect } from "react";
import { Link } from "react-router-dom";
import { formatLongDay } from "../lib/dates.js";
import { LOCALE, t } from "../i18n/index.js";
import { announcementBody, useAnnouncements, useMarkSeen } from "../lib/announcements.js";

/**
 * Nyheter (D108).
 *
 * **Feature announcements go here and never interrupt the dashboard.** The
 * dashboard is where somebody looks to find out how they are doing, and a
 * notice about a new screen sitting above their trend line is the app talking
 * about itself in the one place that is supposed to be about them. The Mer
 * entry carries an unread marker, which is the whole of the interruption.
 *
 * Opening the page marks everything on it read. Not a per-item button: the list
 * is short, the items are two sentences, and a "mark as read" control on each
 * one is a chore invented by software rather than a thing anybody wanted.
 */
export function News() {
  const announcements = useAnnouncements();
  const seen = useMarkSeen();

  const news = announcements.data?.news ?? [];

  /**
   * Marked read on arrival, once per unread item.
   *
   * In an effect rather than at render, because marking read is a write and a
   * render that writes is a render that fires twice under StrictMode.
   */
  const unreadKey = news
    .filter((entry) => !entry.seen)
    .map((entry) => entry.id)
    .join(",");

  useEffect(() => {
    for (const id of unreadKey === "" ? [] : unreadKey.split(",")) {
      seen.mutate(id);
    }
    // Keyed on the ids and their seen state rather than on the array, which is
    // a new object every render. `seen` is a stable mutation object and is
    // deliberately not a dependency: listing it would re-run this on every
    // settled mutation, which is exactly the loop this is trying not to be.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadKey]);

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <h1 className="text-title text-ink">{t("news.title")}</h1>
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("nav.dashboard")}
        </Link>
      </header>

      {announcements.isLoading ? (
        <p role="status" className="text-note text-muted">
          {t("app.loading")}
        </p>
      ) : news.length === 0 ? (
        <p className="text-note text-muted">{t("news.empty")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {news.map((entry) => (
            <li key={entry.id} className="py-4" data-testid={`news-${entry.id}`}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-body text-ink">{entry.title}</h2>
                {!entry.seen ? (
                  <span className="tag tag-logged shrink-0" data-testid="news-unread">
                    {t("news.new")}
                  </span>
                ) : null}
              </div>

              <p className="num mt-0.5 text-micro text-muted">
                {formatLongDay(entry.createdAt.slice(0, 10), LOCALE)}
              </p>

              {announcementBody(entry) ? (
                <p className="mt-2 max-w-prose text-note text-muted">
                  {announcementBody(entry)}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
