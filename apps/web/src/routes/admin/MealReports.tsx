import { formatLongDay } from "../../lib/dates.js";
import { LOCALE, t } from "../../i18n/index.js";
import { useMealReports, useResolveMealReport } from "./api.js";

/**
 * Reports on shared meals (D192).
 *
 * A reader who finds a shared meal that should not be here says why, and this
 * is where an administrator decides: stop sharing it, or leave it. Unsharing
 * takes it out of the shared list and nothing else. The author keeps the meal,
 * and the copies readers already made remain theirs. Both decisions close every
 * open report on that meal and are written to the audit log.
 */
export function MealReports() {
  const reports = useMealReports();
  const resolve = useResolveMealReport();

  if (reports.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const open = reports.data?.reports ?? [];

  return (
    <section data-testid="admin-meal-reports">
      <p className="mb-4 max-w-prose text-note text-muted">{t("admin.reportsWhat")}</p>

      {open.length === 0 ? (
        <p className="text-note text-muted">{t("admin.noReports")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {open.map((report) => (
            <li key={report.id} className="py-3" data-testid={`report-${report.id}`}>
              <p className="text-note text-ink">
                {report.mealName}
                <span className="text-muted">
                  {" · "}
                  {report.authorName ?? t("admin.reportNoName")} ({report.authorEmail})
                </span>
              </p>
              <p className="mt-1 max-w-prose text-note text-ink">{report.reason}</p>
              <p className="num mt-0.5 text-micro text-muted">
                {t("admin.reportBy", {
                  email: report.reporterEmail,
                  date: formatLongDay(report.createdAt.slice(0, 10), LOCALE),
                })}
                {report.shared ? "" : ` · ${t("admin.reportNotShared")}`}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid={`report-unshare-${report.id}`}
                  className="btn-small"
                  disabled={resolve.isPending || !report.shared}
                  onClick={() => resolve.mutate({ id: report.id, action: "unshare" })}
                >
                  {t("admin.reportUnshare")}
                </button>
                <button
                  type="button"
                  data-testid={`report-keep-${report.id}`}
                  className="btn-link"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ id: report.id, action: "keep" })}
                >
                  {t("admin.reportKeep")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
