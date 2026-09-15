import { EXPORT_TABLE_NAMES } from "shared";
import { useExportTables } from "../lib/daily.js";
import { todayLocalDate } from "../lib/dates.js";
import { useMe } from "../lib/session.js";
import { t } from "../i18n/index.js";

/**
 * Taking your data with you, in three formats (D96, D167).
 *
 * The account deletion panel has offered the JSON file since D107, and its hint
 * promised "CSV per tabell" as well, which no screen actually offered. This is
 * the one place all three live, beside each other: Excel for looking at the
 * numbers, JSON for moving the account, CSV for anything else.
 *
 * The Excel link carries the person's own today, because the table's last row
 * is a day in their timezone rather than the server's (§3).
 */
export function ExportData() {
  const me = useMe();
  const today = todayLocalDate(me.data?.profile.timezone ?? "Europe/Stockholm");
  const tables = useExportTables();

  return (
    <section className="mt-10 border-t border-edge pt-6" data-testid="export-data">
      <h2 className="text-base text-ink">{t("export.heading")}</h2>
      <p className="mt-2 max-w-prose text-note text-muted">{t("export.intro")}</p>

      <ul className="mt-4 space-y-4">
        <li>
          <a
            className="text-note text-ink underline underline-offset-4"
            href={`/api/export/xlsx?asOf=${today}`}
            data-testid="export-xlsx"
          >
            {t("export.xlsx")}
          </a>
          <p className="mt-1 max-w-prose text-micro text-muted">{t("export.xlsxHint")}</p>
        </li>
        <li>
          <a
            className="text-note text-ink underline underline-offset-4"
            href="/api/export/json"
            data-testid="export-json"
          >
            {t("export.json")}
          </a>
          <p className="mt-1 max-w-prose text-micro text-muted">{t("export.jsonHint")}</p>
        </li>
        <li>
          <p className="text-note text-ink">{t("export.csv")}</p>
          <p className="mt-1 max-w-prose text-micro text-muted">{t("export.csvHint")}</p>
          {/*
            Only when the answer really is a list. The first version trusted
            the shape, and a response without `tables` took all of
            Inställningar down with it: a render test that stubs every route
            generically is what found that.
          */}
          {Array.isArray(tables.data?.tables) && tables.data.tables.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2" data-testid="export-csv-list">
              {tables.data.tables.map((table) => (
                <li key={table}>
                  <a
                    className="text-micro text-ink underline underline-offset-4"
                    href={`/api/export/csv/${table}`}
                    data-testid={`export-csv-${table}`}
                  >
                    {EXPORT_TABLE_NAMES[table] ?? table}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      </ul>
    </section>
  );
}
