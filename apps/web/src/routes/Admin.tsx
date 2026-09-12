import { Link, useSearchParams } from "react-router-dom";
import { t, type TranslationKey } from "../i18n/index.js";
import { useAdminRequests } from "./admin/api.js";
import { Requests } from "./admin/Requests.js";
import { Users } from "./admin/Users.js";
import { Invites } from "./admin/Invites.js";
import { Mail } from "./admin/Mail.js";
import { MailSettings } from "./admin/MailSettings.js";
import { Backup } from "./admin/Backup.js";
import { Announcements } from "./admin/Announcements.js";
import { Log } from "./admin/Log.js";
import { AdminBuild } from "../components/AppVersion.js";

/**
 * The admin area (D89, D95, D100).
 *
 * Eight tabs rather than one long page. D95 built ten endpoints and this screen
 * called two of them, so the work of this pass is the other eight; putting them
 * all in one column would have produced a page a phone scrolls through for a
 * minute to reach the audit log.
 *
 * **The tab is in the query string** (`?vy=konton`), the same as Data's
 * (D92): a tab you can link to, return to, and leave with the back button doing
 * what it looks like it does. `?vy=` absent means requests, which is the thing
 * that needs answering rather than the thing that is merely interesting.
 *
 * Authorisation is entirely server-side and unchanged. Every endpoint is behind
 * `requireAdmin`, which answers **404** rather than 403, so a non-admin who
 * reaches this URL sees the same thing they would see for any path that does not
 * exist. Nothing on this page is a permission check: the first query failing is
 * what tells the screen it is not for this account.
 */

const TABS = [
  ["forfragningar", "admin.tabRequests"],
  ["konton", "admin.tabUsers"],
  ["koder", "admin.tabInvites"],
  ["mejl", "admin.tabMail"],
  ["mejlserver", "admin.tabMailSettings"],
  ["backup", "admin.tabBackup"],
  ["meddelanden", "admin.tabAnnouncements"],
  ["logg", "admin.tabLog"],
] as const satisfies readonly (readonly [string, TranslationKey])[];

type Tab = (typeof TABS)[number][0];

export function Admin() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("vy");
  const tab: Tab = TABS.some(([key]) => key === requested)
    ? (requested as Tab)
    : "forfragningar";

  /**
   * One query decides whether this account may be here at all.
   *
   * It is the requests list because it is the cheapest of the five and the tab
   * that opens by default. A 404 from it means `requireAdmin` refused, and the
   * screen says the page does not exist, which is what a non-admin should be
   * told and all they should be told.
   */
  const requests = useAdminRequests();

  if (requests.isError) {
    return (
      <main className="mx-auto w-full max-w-3xl px-5 py-8">
        <p className="text-body text-muted">{t("admin.notYours")}</p>
        <p className="mt-4">
          <Link className="text-note text-muted underline underline-offset-4" to="/">
            {t("nav.dashboard")}
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">{t("admin.title")}</h1>
          {/*
            Which build this installation is running (D151). Here because an
            admin looking at a log line or a failed job needs to know which
            version wrote it, and because this is the screen somebody opens when
            something is wrong. Same source as the boot log's first line.
          */}
          <AdminBuild />
        </div>
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("nav.dashboard")}
        </Link>
      </header>

      <div role="tablist" aria-label={t("admin.title")} className="mb-6 flex flex-wrap gap-2">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            data-testid={`tab-${key}`}
            className={[
              "min-h-11 rounded-lg border px-4 text-note transition-colors",
              tab === key ? "border-logged bg-logged/15 text-ink" : "border-edge text-muted",
            ].join(" ")}
            onClick={() =>
              setParams(key === "forfragningar" ? {} : { vy: key }, { replace: true })
            }
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === "forfragningar" ? <Requests /> : null}
      {tab === "konton" ? <Users /> : null}
      {tab === "koder" ? <Invites /> : null}
      {tab === "mejl" ? <Mail /> : null}
      {tab === "mejlserver" ? <MailSettings /> : null}
      {tab === "backup" ? <Backup /> : null}
      {tab === "meddelanden" ? <Announcements /> : null}
      {tab === "logg" ? <Log /> : null}
    </main>
  );
}
