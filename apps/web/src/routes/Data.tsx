import { useMemo, useState } from "react";
import { Correlations } from "./Correlations.js";
import { Link, useSearchParams } from "react-router-dom";
import { addDays, eachDay, type DailyLogEntry } from "shared";
import { useActivities, useDailyLogs, useMeasurements } from "../lib/daily.js";
import { useIntakeSeries } from "../lib/log.js";
import { useMe } from "../lib/session.js";
import { formatLongDay, todayLocalDate } from "../lib/dates.js";
import { RangeSelector, rangeDays, type RangeKey } from "../components/RangeSelector.js";
import { SeriesPanel, type SeriesPoint } from "../components/SeriesPanel.js";
import { OfflineNotice } from "../components/SyncIndicator.js";
import { useIsWide } from "../lib/tokens.js";
import { LOCALE, t, type TranslationKey } from "../i18n/index.js";

/**
 * The data section: somewhere to look at what has been logged.
 *
 * A place to dig rather than a summary. The dashboard answers "how is it
 * going"; this answers "what does the sleep column actually look like", which
 * is a different question and deserves its own screen rather than three more
 * cards on a screen that already has enough.
 *
 * **It is a viewer, not an analysis (D34).** No correlation coefficients, no
 * fitted lines, no causal language. Two series sitting next to each other is
 * not a claim that one moves the other, and the app does not get to imply one
 * by drawing a trend through a scatter of self-reported answers. D34 settled
 * that for the correlation screen and the same reasoning applies here, more so
 * because there are ten series and the temptation to rank them is stronger.
 *
 * **Self-reported 1-5 scales plot as points.** Never a line, never smoothed. A
 * person picking one of five words is not a continuous measurement, and joining
 * the dots draws values on days nobody answered.
 *
 * **Every panel says what it covers.** The range, and how many of its days
 * carry that series. A series with four points across ninety days is a
 * legitimate thing to look at and a dishonest thing to present as continuous.
 *
 * Desktop-first and deliberately dense: two columns from `lg`, one below.
 * At 360 px it is the same panels, stacked and shorter, rather than a different
 * screen with less in it.
 */
/**
 * The series this screen shows, in the order they are read.
 *
 * A table rather than ten inline elements, because the same list has to drive
 * two layouts now: a grid on a wide screen and a picker on a narrow one. Two
 * copies of it would be two places to forget a series.
 */
type Series = {
  key: string;
  label: TranslationKey;
  /** A dictionary key, not a literal: these are words on screen. */
  unit?: TranslationKey;
  kind: "scale" | "amount" | "measure";
  decimals?: number;
  tone?: "data" | "nutrition";
  /** Which value a day carries, or null when it carries none. */
  read: (day: string, lookup: Lookup) => number | null;
};

type Lookup = {
  daily: Map<string, DailyLogEntry>;
  waist: Map<string, number>;
  minutes: Map<string, number>;
  kcal: Map<string, number | null>;
};

const rating =
  (field: "energy" | "mood" | "sweat" | "hunger") =>
  (day: string, lookup: Lookup) =>
    lookup.daily.get(day)?.[field] ?? null;

const SERIES: Series[] = [
  { key: "energy", label: "daily.energy", kind: "scale", read: rating("energy") },
  { key: "mood", label: "daily.mood", kind: "scale", read: rating("mood") },
  { key: "sweat", label: "daily.sweat", kind: "scale", read: rating("sweat") },
  { key: "hunger", label: "daily.hunger", kind: "scale", read: rating("hunger") },
  {
    key: "sleep",
    label: "data.sleep",
    unit: "data.hoursUnit",
    kind: "amount",
    decimals: 1,
    read: (day, lookup) => lookup.daily.get(day)?.sleepHours ?? null,
  },
  {
    key: "steps",
    label: "data.steps",
    unit: "data.stepsUnit",
    kind: "amount",
    read: (day, lookup) => lookup.daily.get(day)?.steps ?? null,
  },
  {
    key: "alcohol",
    label: "data.alcohol",
    unit: "data.alcoholUnit",
    kind: "amount",
    decimals: 1,
    read: (day, lookup) => lookup.daily.get(day)?.alcoholUnits ?? null,
  },
  {
    key: "activity",
    label: "data.activity",
    unit: "data.activityUnit",
    kind: "amount",
    read: (day, lookup) => lookup.minutes.get(day) ?? null,
  },
  {
    key: "waist",
    label: "data.waist",
    unit: "data.cmUnit",
    kind: "measure",
    decimals: 1,
    read: (day, lookup) => lookup.waist.get(day) ?? null,
  },
  {
    // The one series that is not Is (profile, page 8).
    tone: "nutrition",
    key: "intake",
    label: "data.intake",
    unit: "data.kcalUnit",
    kind: "amount",
    read: (day, lookup) => lookup.kcal.get(day) ?? null,
  },
];

type Tab = "serier" | "samband";

export function Data() {
  const me = useMe();
  const timezone = me.data?.profile.timezone ?? "Europe/Stockholm";
  const today = todayLocalDate(timezone);

  const [range, setRange] = useState<RangeKey>("90");
  /**
   * Which view. In the URL rather than in state alone, so a tab is a place a
   * person can return to and the browser's back button does what it looks like
   * it does.
   */
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("vy") === "samband" ? "samband" : "serier";

  const dailyLogs = useDailyLogs();
  const activities = useActivities();
  const measurements = useMeasurements();

  /**
   * The window, as a list of every day in it.
   *
   * Built from the calendar rather than from the rows, so a day with nothing
   * logged is a gap in every panel at the same x position. Panels built only
   * from the days that have data would each have their own axis and could not
   * be read against one another, which is the entire reason they are on one
   * screen.
   */
  const days = useMemo(() => {
    const span = rangeDays(range);
    const earliest = [
      ...dailyLogs.data?.map((row) => row.localDate) ?? [],
      ...activities.data?.map((row) => row.localDate) ?? [],
      ...measurements.data?.map((row) => row.localDate) ?? [],
    ].sort()[0];

    const from =
      span === null ? (earliest ?? addDays(today, -29)) : addDays(today, -(span - 1));
    return [...eachDay(from > today ? today : from, today)];
  }, [range, today, dailyLogs.data, activities.data, measurements.data]);

  const from = days[0] ?? today;
  const intake = useIntakeSeries(from, today);

  /** One lookup per series, so each panel is a map read rather than a scan. */
  const byDay = useMemo(() => {
    const daily = new Map(dailyLogs.data?.map((row) => [row.localDate, row]) ?? []);
    const waist = new Map(
      (measurements.data ?? [])
        .filter((row) => row.waistCm !== null)
        .map((row) => [row.localDate, row.waistCm!]),
    );

    /** Several sessions a day is normal, so the day's minutes are their sum. */
    const minutes = new Map<string, number>();
    for (const row of activities.data ?? []) {
      minutes.set(row.localDate, (minutes.get(row.localDate) ?? 0) + row.durationMin);
    }

    const kcal = new Map(intake.data?.map((row) => [row.localDate, row.kcal]) ?? []);

    return { daily, waist, minutes, kcal };
  }, [dailyLogs.data, measurements.data, activities.data, intake.data]);

  const wide = useIsWide();
  const [picked, setPicked] = useState<string>("energy");

  /** One panel's props, from the table and the day lookup. */
  const panelProps = (series: Series) => ({
    title: t(series.label),
    ...(series.unit ? { unit: t(series.unit) } : {}),
    kind: series.kind,
    ...(series.decimals === undefined ? {} : { decimals: series.decimals }),
    ...(series.tone ? { tone: series.tone } : {}),
    points: days.map((localDate) => ({
      localDate,
      value: series.read(localDate, byDay),
    })) satisfies SeriesPoint[],
  });

  const loading =
    dailyLogs.isPending || activities.isPending || measurements.isPending || intake.isPending;
  const failed =
    dailyLogs.isError || activities.isError || measurements.isError || intake.isError;

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">{t("data.title")}</h1>
          <p className="max-w-prose text-note text-muted">{t("data.subtitle")}</p>
        </div>
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("nav.dashboard")}
        </Link>
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <RangeSelector value={range} onChange={setRange} />
        <p className="num text-micro text-muted">
          {t("data.window", {
            from: formatLongDay(from, LOCALE),
            to: formatLongDay(today, LOCALE),
            days: days.length,
          })}
        </p>
      </div>

      {/*
        Two views of one set of series (D92). Tabs rather than two routes,
        because they answer the same question at different resolutions and
        because the second one was unreachable on a phone as a route.
      */}
      <div role="tablist" aria-label={t("data.views")} className="mb-6 flex gap-2">
        {(
          [
            ["serier", "data.tabSeries"],
            ["samband", "data.tabCorrelations"],
          ] as const
        ).map(([key, label]) => (
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
            onClick={() => setParams(key === "serier" ? {} : { vy: key }, { replace: true })}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {tab === "samband" ? <Correlations /> : null}

      {failed ? <OfflineNotice what="data" /> : null}

      {tab === "samband" ? null : loading ? (
        <p role="status" className="text-note text-muted">
          {t("app.loading")}
        </p>
      ) : wide ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {SERIES.map((series) => (
            <SeriesPanel key={series.key} {...panelProps(series)} />
          ))}
        </div>
      ) : (
        /*
          Portrait: one series at a time, chosen from a list.
          
          Not hidden, and not the same page with a scrollbar. Ten dense panels
          stacked is 2 800 px of thumb travel on a phone, which is a way of
          having the screen without anyone using it. One at a time is what this
          screen is for anyway — you come here to look at *sleep*, not at ten
          things — and the selector makes that the first decision rather than a
          scroll.
        */
        <div>
          <label className="label" htmlFor="data-series">
            {t("data.pickSeries")}
          </label>
          <select
            id="data-series"
            data-testid="series-picker"
            className="select mb-4"
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
          >
            {SERIES.map((series) => (
              <option key={series.key} value={series.key}>
                {t(series.label)}
              </option>
            ))}
          </select>

          <SeriesPanel {...panelProps(SERIES.find((s) => s.key === picked) ?? SERIES[0]!)} />
        </div>
      )}

      {/*
        Said once, at the foot, in the same register as the correlation screen's
        own footer. Not a disclaimer bolted on: it is the difference between a
        viewer and something that looks like it is making an argument.
      */}
      <p className="mx-auto mt-8 max-w-prose text-micro text-muted">{t("data.footer")}</p>
    </main>
  );
}
