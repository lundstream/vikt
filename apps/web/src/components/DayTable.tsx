import { useMemo, useState } from "react";
import type { DayTableResponse } from "shared";
import { formatDecimal, formatKcal } from "shared";
import { useDayTable } from "../lib/daily.js";
import { OfflineNotice } from "./SyncIndicator.js";
import { t, type TranslationKey } from "../i18n/index.js";

type Row = DayTableResponse["rows"][number];
type MacroKey = "protein" | "carbs" | "fat" | "fiber";

type Column = {
  key: string;
  label: TranslationKey;
  /** What the column sorts by. Null sorts last in both directions. */
  sort: (row: Row) => number | string | null;
  cell: (row: Row) => React.ReactNode;
};

const decimal = (value: number | null, decimals: number) =>
  value === null ? null : formatDecimal(value, { decimals });

const dayFormat = new Intl.DateTimeFormat("sv-SE", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const macroColumn = (key: MacroKey, label: TranslationKey): Column => ({
  key,
  label,
  sort: (row) => row[key].grams,
  cell: (row) => {
    const { grams, complete } = row[key];
    if (grams === null) return null;
    const amount = formatDecimal(grams, { decimals: 0 });
    // Below D55's gate the known sum is a floor, in Sten, as everywhere else.
    return complete ? amount : <span className="figure-partial">{t("days.atLeast", { amount })}</span>;
  },
});

const COLUMNS: Column[] = [
  {
    key: "date",
    label: "days.date",
    sort: (row) => row.localDate,
    cell: (row) => dayFormat.format(new Date(`${row.localDate}T12:00:00Z`)),
  },
  { key: "weight", label: "days.weight", sort: (row) => row.weightKg, cell: (row) => decimal(row.weightKg, 1) },
  {
    key: "trend",
    label: "days.trend",
    sort: (row) => row.trendKg,
    // Plain, not Lingon: §5 gives Lingon to the trend line and the wordmark,
    // and a figure in a table is neither.
    cell: (row) => decimal(row.trendKg, 1),
  },
  {
    key: "intake",
    label: "days.intake",
    sort: (row) => row.intakeKcal,
    cell: (row) =>
      row.intakeKcal === null ? null : (
        <>
          {formatKcal(row.intakeKcal)}
          {row.intakeCoverage !== null && row.intakeCoverage < 1 ? (
            <span className="ml-2 text-muted">
              {t("days.coverage", { percent: Math.round(row.intakeCoverage * 100) })}
            </span>
          ) : null}
        </>
      ),
  },
  macroColumn("protein", "days.protein"),
  macroColumn("carbs", "days.carbs"),
  macroColumn("fat", "days.fat"),
  macroColumn("fiber", "days.fiber"),
  { key: "alcohol", label: "days.alcohol", sort: (row) => row.alcoholUnits, cell: (row) => decimal(row.alcoholUnits, 1) },
  { key: "activity", label: "days.activity", sort: (row) => row.activityMinutes, cell: (row) => decimal(row.activityMinutes, 0) },
  { key: "steps", label: "days.steps", sort: (row) => row.steps, cell: (row) => decimal(row.steps, 0) },
  { key: "sleep", label: "days.sleep", sort: (row) => row.sleepHours, cell: (row) => decimal(row.sleepHours, 1) },
  { key: "energy", label: "days.energy", sort: (row) => row.energy, cell: (row) => decimal(row.energy, 0) },
  { key: "mood", label: "days.mood", sort: (row) => row.mood, cell: (row) => decimal(row.mood, 0) },
  { key: "waist", label: "days.waist", sort: (row) => row.waistCm, cell: (row) => decimal(row.waistCm, 1) },
  {
    key: "maintenance",
    label: "days.maintenance",
    sort: (row) => row.maintenanceKcal,
    cell: (row) =>
      row.maintenanceKcal === null ? null : (
        <>
          {formatKcal(row.maintenanceKcal)}
          <span className="ml-2 text-muted">
            {t(row.maintenanceSource === "adaptive" ? "days.sourceAdaptive" : "days.sourceFormula")}
          </span>
        </>
      ),
  },
  {
    key: "balance",
    label: "days.balance",
    sort: (row) => row.intakeMinusMaintenanceKcal,
    cell: (row) =>
      row.intakeMinusMaintenanceKcal === null
        ? null
        : `${row.intakeMinusMaintenanceKcal > 0 ? "+" : ""}${formatKcal(row.intakeMinusMaintenanceKcal)}`,
  },
];

type Sort = { key: string; direction: "asc" | "desc" };

/**
 * One row per day, sortable by any column (D167).
 *
 * Every figure comes from `buildDayTable` through the API and is printed with
 * the shared formatter, so a number here is the number on Översikt for that day.
 * An empty cell is a figure that is not filled in, never a zero, and never a
 * dash (§5).
 *
 * **It scrolls sideways in its own region**, so seventeen columns on a phone move
 * the table and not the page. The region is focusable, which is what lets a
 * keyboard scroll it, and it carries a label saying what it is.
 */
export function DayTable({ rows }: { rows: Row[] }) {
  // Newest first: the day somebody opens this to look at is usually a recent one.
  const [sort, setSort] = useState<Sort>({ key: "date", direction: "desc" });

  const sorted = useMemo(() => {
    const column = COLUMNS.find((candidate) => candidate.key === sort.key) ?? COLUMNS[0]!;
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sort(a);
      const right = column.sort(b);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return left < right ? -sign : left > right ? sign : 0;
    });
  }, [rows, sort]);

  function toggle(key: string) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "date" ? "desc" : "asc" },
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-lg border border-edge"
      role="region"
      aria-label={t("days.region")}
      tabIndex={0}
      data-testid="day-table-region"
    >
      <table className="num w-max min-w-full border-collapse text-note" data-testid="day-table">
        <thead>
          <tr className="border-b border-edge">
            {COLUMNS.map((column) => {
              const active = sort.key === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                  className={`px-3 py-2 font-normal ${column.key === "date" ? "sticky left-0 bg-card text-left" : "text-right"}`}
                >
                  <button
                    type="button"
                    data-testid={`sort-${column.key}`}
                    className={`whitespace-nowrap text-micro ${active ? "text-ink" : "text-muted"}`}
                    aria-label={t("days.sortBy", { column: t(column.label) })}
                    onClick={() => toggle(column.key)}
                  >
                    {t(column.label)}
                    {active ? <span aria-hidden="true">{sort.direction === "asc" ? " ▲" : " ▼"}</span> : null}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.localDate} className="border-b border-edge last:border-b-0" data-testid={`day-row-${row.localDate}`}>
              {COLUMNS.map((column) => (
                <td
                  key={column.key}
                  data-column={column.key}
                  className={`whitespace-nowrap px-3 py-2 ${column.key === "date" ? "sticky left-0 bg-card text-left text-muted" : "text-right text-ink"}`}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The table for a range, with its loading, offline and empty states. */
export function DayTableView({ from, to }: { from: string; to: string }) {
  const table = useDayTable(from, to);

  if (table.isError) return <OfflineNotice what="data" />;
  if (table.isPending) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  return (
    <section>
      {table.data.rows.length === 0 ? (
        <p className="text-note text-muted">{t("days.empty")}</p>
      ) : (
        <DayTable rows={table.data.rows} />
      )}
      <p className="mt-3 max-w-prose text-micro text-muted">{t("days.note")}</p>
    </section>
  );
}
