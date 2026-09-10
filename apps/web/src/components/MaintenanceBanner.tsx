import { announcementBody, useAnnouncements, useMarkSeen } from "../lib/announcements.js";
import { AnnouncementLine } from "./Announcement.js";
import { t } from "../i18n/index.js";

/**
 * The maintenance notice (D108).
 *
 * **No accent colour, deliberately.** §5's map gives a colour to an *area*, and
 * planned maintenance is not one: it is not the trend, not something logged, not
 * money, not nutrition. It is also not a failure, and §3 is explicit that this
 * app has no failure state — a banner in red would make one out of a Tuesday
 * evening restart that costs the reader nothing. Sten and Snö on the card
 * surface, like every other quiet thing.
 *
 * Dismissible per person, and back if the announcement changes: the dismissal
 * records the version it dismissed, so a window that moves is a new thing to be
 * told rather than a silenced one.
 */
export function MaintenanceBanner() {
  const announcements = useAnnouncements();
  const seen = useMarkSeen();

  const banner = announcements.data?.banner ?? null;
  if (!banner) return null;

  return (
    <section
      className="mx-auto mb-4 w-full max-w-3xl rounded-card border border-edge bg-card px-4 py-3"
      data-testid="maintenance-banner"
      role="status"
    >
      <div className="flex items-baseline justify-between gap-4">
        {/*
          One line, formatted but not laid out (D128). A maintenance notice is
          a sentence beside a dismiss button; an announcement with a heading and
          a list in it wanted the news page, and a banner that grows to fill the
          top of every screen is worse than one that says less than it could.
        */}
        <p className="text-note text-ink">
          <strong className="font-semibold">{banner.title}</strong>{" "}
          <span className="text-muted">
            <AnnouncementLine markdown={announcementBody(banner)} />
          </span>
        </p>

        <button
          type="button"
          data-testid="dismiss-banner"
          className="min-h-11 shrink-0 text-note text-muted underline underline-offset-4"
          disabled={seen.isPending}
          onClick={() => seen.mutate(banner.id)}
        >
          {t("announce.dismiss")}
        </button>
      </div>
    </section>
  );
}
