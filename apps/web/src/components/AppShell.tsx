import { useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { SyncIndicator } from "./SyncIndicator.js";
import { Sheet } from "./Sheet.js";
import { useLogout, useMe } from "../lib/session.js";
import { useAnnouncements } from "../lib/announcements.js";
import { MaintenanceBanner } from "./MaintenanceBanner.js";
import { useServiceWorker } from "../lib/update.js";
import { t, type TranslationKey } from "../i18n/index.js";
import { HeaderLockup } from "./Wordmark.js";
import { ThemeApplier } from "./ThemeChoice.js";

/**
 * One shell, two shapes.
 *
 * Mobile gets a bottom bar of four destinations. Desktop gets a sidebar and the
 * wide dashboard. The *components* are the same in both, which is the point:
 * this is a layout switch, not a second app, so a screen fixed on one is fixed
 * on both.
 *
 * The bar sits above the home indicator via `env(safe-area-inset-bottom)`,
 * because in standalone display mode there is no browser chrome between the
 * app and the bottom of the phone.
 */

/**
 * One destination, and everywhere it can appear (D115).
 *
 * `inBar` and `adminOnly` are properties of the *destination*, not of a
 * surface, which is the whole change. Every navigation surface now derives what
 * it draws from this one list, so a destination cannot exist in one and be
 * missing from another: the sidebar renders all of them, the bar renders the
 * four marked `inBar`, and the Mer sheet renders the rest. Adding a screen is
 * one line here rather than three edits nobody remembers to make together.
 */
type Destination = {
  to: string;
  label: TranslationKey;
  /** Drawn from a path, not an icon font: two fewer requests and it scales. */
  icon: ReactNode;
  /**
   * One of the four slots in the phone's bottom bar.
   *
   * Four, not five: a fifth destination and the Mer button would be six targets
   * across 360 px, which is 60 px each and below what a thumb can hit reliably.
   * Everything not marked overflows into the sheet, which is what Mer is.
   */
  inBar?: boolean;
  /** Drawn for admins only (D100). The server decides everything else. */
  adminOnly?: boolean;
};

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * Every place in the signed-in app, in the order they are drawn.
 *
 * The inventory that produced this list found the two surfaces had drifted
 * apart in both directions and in a way neither could see (D115). The sidebar
 * had five destinations and a bare text link to Inställningar in its footer; the
 * Mer sheet had six and a sign-out. So the desktop had **no way to sign out at
 * all**, no Nyheter, no Profil and no Administration, and Inställningar was
 * present but demoted to a footnote without an icon. None of that was reported
 * as four bugs, because from inside either surface everything looked complete.
 *
 * `navigation.test.tsx` now fails if a route with a screen is missing from here,
 * or if the two surfaces stop covering the same set.
 */
const DESTINATIONS: Destination[] = [
  {
    to: "/",
    label: "nav.dashboard",
    inBar: true,
    icon: <path d="M3 15 C 7 15, 9 9, 12 8 C 15 7, 18 10, 21 9" {...stroke} />,
  },
  {
    to: "/dag",
    inBar: true,
    label: "nav.daily",
    icon: (
      <>
        <rect x="4" y="5" width="16" height="16" rx="2" {...stroke} />
        <path d="M8 3v4M16 3v4M4 11h16" {...stroke} />
      </>
    ),
  },
  {
    to: "/food",
    inBar: true,
    label: "nav.food",
    icon: (
      <>
        <path d="M6 3v8a2 2 0 0 0 4 0V3M8 11v10" {...stroke} />
        <path d="M17 3c-1.5 2-2 4-2 6a2 2 0 0 0 2 2v10" {...stroke} />
      </>
    ),
  },
  {
    to: "/framsteg",
    inBar: true,
    label: "nav.progress",
    icon: (
      <>
        <path d="M8 21h8M12 17v4" {...stroke} />
        <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" {...stroke} />
      </>
    ),
  },
  {
    /**
     * Not in the bar: it has a place in the sidebar and, on a phone, a place in
     * the Mer sheet (D92). What it must not have is a sixth slot in the bar.
     */
    to: "/data",
    label: "nav.data",
    icon: (
      <>
        <path d="M4 4v16h16" {...stroke} />
        <path d="M8 16v-4M12 16v-7M16 16v-2M20 16v-5" {...stroke} />
      </>
    ),
  },
  {
    to: "/nyheter",
    label: "news.title",
    icon: (
      <>
        <path d="M4.75 6.25h11.5v13.5H6.5a1.75 1.75 0 0 1-1.75-1.75Z" {...stroke} />
        <path d="M16.25 9.25h1.5A1.75 1.75 0 0 1 19.5 11v7a1.75 1.75 0 0 1-3.25.9" {...stroke} />
        <path d="M7.75 9.5h5.5M7.75 12.5h5.5M7.75 15.5h3.5" {...stroke} />
      </>
    ),
  },
  {
    to: "/profile",
    label: "profile.title",
    icon: (
      <>
        <circle cx="12" cy="8" r="3.5" {...stroke} />
        <path d="M4.5 20a7.5 7.5 0 0 1 15 0" {...stroke} />
      </>
    ),
  },
  {
    to: "/installningar",
    label: "nav.settings",
    /**
     * A gear, not a sun (D115).
     *
     * The old icon was a circle with eight rays around it, which is a sun, and
     * a sun beside "Inställningar" reads as a theme toggle. That misreading is
     * about to get worse rather than better, since the theme choice now lives
     * on the screen behind it: the icon would have named one setting on a page
     * of settings.
     *
     * A gear is drawn as a toothed ring rather than as eight spokes: the teeth
     * are short arcs on the outside of a thick ring, so at 20 px it reads as a
     * cog and not as a star.
     */
    icon: (
      <>
        <circle cx="12" cy="12" r="3.25" {...stroke} />
        <path
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
          {...stroke}
        />
      </>
    ),
  },
  {
    /**
     * The admin entry, for admins only (D100).
     *
     * D89 left the route unlinked on the grounds that a non-admin has no
     * business learning it exists. The link's absence protected nothing:
     * `/admin` is in the bundle every account downloads, so anyone curious
     * enough to read it finds the path in seconds. What actually protects it is
     * `requireAdmin` answering **404**, and that is unchanged.
     *
     * `me.data?.isAdmin` decides whether a link is drawn and authorises
     * nothing. It is now in the list rather than pushed onto one surface's copy
     * of it, which is why it reaches the sidebar as well.
     */
    to: "/admin",
    label: "admin.title",
    adminOnly: true,
    icon: (
      <>
        <path d="M12 3.5 5 6.5v5c0 4 2.9 7.6 7 9 4.1-1.4 7-5 7-9v-5Z" {...stroke} />
        <path d="M9.5 12.5 11.5 14.5 15 10.5" {...stroke} />
      </>
    ),
  },
];

/** The sign-out icon, which is an action rather than a destination. */
const SIGN_OUT_ICON = (
  <>
    <path d="M15 4.5h3.5A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5H15" {...stroke} />
    <path d="M10 8.5 6.5 12 10 15.5M6.5 12H15" {...stroke} />
  </>
);

/**
 * The destinations an account may see, which is all of them bar Administration.
 *
 * Exported so the navigation test can assert the two surfaces cover the same
 * set without reaching into a module-private constant.
 */
export function destinationsFor(isAdmin: boolean): Destination[] {
  return DESTINATIONS.filter((destination) => !destination.adminOnly || isAdmin);
}

/** The four in the bar, and everything that overflows into Mer. */
export const inBar = (destination: Destination) => destination.inBar === true;

export function AppShell({ children }: { children: ReactNode }) {
  const { updateReady, applyUpdate } = useServiceWorker();

  return (
    <div className="min-h-dvh sm:flex">
      {/*
        Renders nothing. It puts the account's theme on the document and keeps
        it there (D117), mounted in the shell so the choice applies on every
        screen rather than only on the one that sets it.
      */}
      <ThemeApplier />

      <Sidebar />

      {/*
        A new version waits rather than taking over. Reloading under someone
        mid-entry loses what they were typing, and this app is used one-handed
        before breakfast.
      */}
      {updateReady ? (
        <div
          role="status"
          data-testid="update-prompt"
          className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-edge bg-paper px-4 py-2 text-micro text-muted"
        >
          {t("update.available")}
          <button
            type="button"
            className="px-2 py-1 text-ink underline underline-offset-4"
            onClick={applyUpdate}
          >
            {t("update.reload")}
          </button>
        </div>
      ) : null}

      {/*
        Bottom padding on mobile clears the bar, and only on mobile: on desktop
        the bar is not there and the space would be a gap under every screen.
      */}
      <div className="min-w-0 flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
        {/*
          Above the screen rather than inside it (D108). A planned outage is a
          fact about the app, not about whatever page you happen to be on, and
          putting it in the shell means one place renders it rather than nine
          screens remembering to.
        */}
        <div className="px-5 pt-4">
          <MaintenanceBanner />
        </div>
        {children}
      </div>

      <BottomBar />
    </div>
  );
}

/**
 * A destination row, in whichever surface is asking (D115).
 *
 * The same markup for the sidebar and the sheet, so the two cannot drift in
 * appearance the way they drifted in content: an icon, a label, the current
 * page marked, and a test id derived from the path rather than written by hand.
 */
function DestinationRow({
  destination,
  current,
  onNavigate,
  prefix,
  className,
}: {
  destination: Destination;
  current: boolean;
  onNavigate?: () => void;
  /** `more-` or `side-`, so a test can name a row on one surface. */
  prefix: string;
  className: string;
}) {
  return (
    <Link
      to={destination.to}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      data-testid={`${prefix}${destination.to === "/" ? "dashboard" : destination.to.slice(1)}`}
      className={className}
    >
      <svg viewBox="0 0 24 24" className="size-5 shrink-0" aria-hidden="true">
        {destination.icon}
      </svg>
      {t(destination.label)}
    </Link>
  );
}

/** Desktop. Hidden below `sm`, where the bottom bar takes over. */
function Sidebar() {
  const { pathname } = useLocation();
  const me = useMe();
  const signOut = useLogout();
  const unread = useAnnouncements().data?.unread ?? 0;

  return (
    <nav
      aria-label={t("nav.main")}
      data-testid="sidebar"
      className="hidden w-52 shrink-0 flex-col border-r border-edge px-4 py-8 sm:flex"
    >
      {/*
        The wordmark alone, at 20 pt (profile, page 7). Never the mark here: it
        would compete with the graph directly beneath it.
      */}
      <p className="mb-8 px-2">
        <HeaderLockup />
      </p>

      {/*
        Every destination, not the five that used to be here (D115). Nyheter,
        Profil and Administration were in the Mer sheet and nowhere on desktop,
        and Inställningar was a bare underlined link in the footer below,
        without an icon, which made it read as fine print rather than as a
        place.
      */}
      <ul className="space-y-1">
        {destinationsFor(me.data?.isAdmin ?? false).map((destination) => (
          <li key={destination.to} className="relative">
            <DestinationRow
              destination={destination}
              current={pathname === destination.to}
              prefix="side-"
              className={[
                "flex items-center gap-3 rounded-md px-2 py-2 text-note transition-colors",
                pathname === destination.to
                  ? "bg-edge/50 text-ink"
                  : "text-muted hover:text-ink",
              ].join(" ")}
            />
            {/* The same unread dot the Mer button carries on a phone (D108). */}
            {destination.to === "/nyheter" && unread > 0 ? (
              <span
                data-testid="side-unread"
                aria-label={t("news.unread")}
                className="pointer-events-none absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full bg-logged"
              />
            ) : null}
          </li>
        ))}
      </ul>

      {/*
        Sign out was missing from the desktop entirely: it existed only in the
        Mer sheet, which is `sm:hidden`, so on a wide screen there was no way to
        leave except clearing a cookie (D115).

        At the bottom and quieter than a destination, because it is an action
        and not a place, and because it is the one control here nobody wants to
        hit by accident.
      */}
      <div className="mt-auto space-y-3 pt-8">
        <div className="px-2">
          <SyncIndicator />
        </div>
        <button
          type="button"
          data-testid="side-signout"
          className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-note text-muted transition-colors hover:text-ink"
          onClick={() => signOut.mutate()}
        >
          <svg viewBox="0 0 24 24" className="size-5 shrink-0" aria-hidden="true">
            {SIGN_OUT_ICON}
          </svg>
          {t("auth.signOut")}
        </button>
      </div>
    </nav>
  );
}

/**
 * Mobile: four destinations, evenly spaced, and nothing raised above them.
 *
 * **The centre log button is gone (D53).** It was one affordance that meant
 * "log" and did exactly one thing — open the weight sheet — so someone who
 * tapped it wanting to log a meal got the wrong sheet and no way to have known.
 * Expanding it into three would have layered a second navigation over the one
 * already at the bottom of the screen. The dashboard's quick actions do the job
 * instead: three labelled targets, one tap each, always visible.
 *
 * What the bar gains is the shape it should have had: four equal destinations
 * and no notch cut out of the middle for a button that was not a destination.
 */
function BottomBar() {
  const { pathname, search } = useLocation();
  const unread = useAnnouncements().data?.unread ?? 0;
  const me = useMe();
  const reachable = destinationsFor(me.data?.isAdmin ?? false).filter(inBar);
  const [moreOpen, setMoreOpen] = useState(false);

  const item = (destination: Destination) => (
    <li key={destination.to} className="flex-1">
      <Link
        to={destination.to}
        aria-current={
          pathname === destination.to && search === "" ? "page" : undefined
        }
        // 4rem tall: a real target, not a 24 px one.
        className={[
          "flex h-16 flex-col items-center justify-center gap-1 text-[11px]",
          pathname === destination.to ? "text-ink" : "text-muted",
        ].join(" ")}
      >
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
          {destination.icon}
        </svg>
        {t(destination.label)}
      </Link>
    </li>
  );

  return (
    <>
      {/*
        The indicator sits above the bar rather than inside it, so it never
        competes with a destination for the tap. It renders nothing at all when
        the queue is clean, which is almost always.
      */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-40 flex justify-center pb-1 sm:hidden">
        <SyncIndicator />
      </div>

      <nav
        aria-label={t("nav.main")}
        data-testid="bottom-bar"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-paper pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        <ul className="flex items-stretch">
          {reachable.map(item)}
          {/*
            The fifth item (D92).

            Data, Profil and Inställningar existed only in the landscape
            sidebar, which meant that on a portrait phone — the way this app is
            actually used — they were unreachable except by typing a URL. This
            is the standard overflow for a bottom bar and it stays under a
            thumb.

            Labelled, and deliberately not a hamburger: in a bar of four
            labelled tabs an unlabelled icon is the one thing nobody can read,
            and the label costs nothing. D53 removed the raised centre button,
            which is what left room for a fifth item without crowding.
          */}
          <li className="flex-1">
            <button
              type="button"
              data-testid="nav-more"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(true)}
              className="relative flex min-h-16 w-full flex-col items-center justify-center gap-1 text-micro text-muted"
            >
              <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
                <circle cx="5" cy="12" r="1.6" {...stroke} />
                <circle cx="12" cy="12" r="1.6" {...stroke} />
                <circle cx="19" cy="12" r="1.6" {...stroke} />
              </svg>
              {t("nav.more")}

              {/*
                Something unread behind this button (D108). A dot rather than a
                count: the number is never large enough to be information, and
                a badge with a number on it is the shape of an app that wants
                attention rather than one that has something to say. Gran,
                because it marks a thing to look at rather than a problem.
              */}
              {unread > 0 ? (
                <span
                  data-testid="more-unread"
                  aria-label={t("news.unread")}
                  className="absolute right-1/2 top-2 size-2 translate-x-4 rounded-full bg-logged"
                />
              ) : null}
            </button>
          </li>
        </ul>
      </nav>

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}

/**
 * What did not fit in the bar (D92, D115).
 *
 * A sheet rather than a menu, because it is the same component the rest of the
 * app opens things in, and because a sheet closes on Escape and returns focus,
 * which a hand-rolled dropdown would have to be taught.
 *
 * Its contents are **derived**, not listed: everything the account may see that
 * is not in the bar. That is what makes the sheet and the sidebar cover the same
 * set by construction rather than by two people remembering to edit both.
 */
function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const signOut = useLogout();
  const me = useMe();
  const { pathname } = useLocation();

  const links = destinationsFor(me.data?.isAdmin ?? false).filter(
    (destination) => !inBar(destination),
  );

  return (
    <Sheet open={open} onClose={onClose} title={t("nav.more")} testId="more-sheet">
      <ul className="divide-y divide-edge border-y border-edge">
        {links.map((destination) => (
          <li key={destination.to}>
            <DestinationRow
              destination={destination}
              current={pathname === destination.to}
              onNavigate={onClose}
              prefix="more-"
              className={[
                "flex items-center gap-3 py-3 text-body transition-colors",
                pathname === destination.to ? "text-ink" : "text-muted hover:text-ink",
              ].join(" ")}
            />
          </li>
        ))}
        <li>
          <button
            type="button"
            data-testid="more-signout"
            className="flex w-full items-center gap-3 py-3 text-left text-body text-muted transition-colors hover:text-ink"
            onClick={() => {
              onClose();
              signOut.mutate();
            }}
          >
            <svg viewBox="0 0 24 24" className="size-5 shrink-0" aria-hidden="true">
              {SIGN_OUT_ICON}
            </svg>
            {t("auth.signOut")}
          </button>
        </li>
      </ul>
    </Sheet>
  );
}
