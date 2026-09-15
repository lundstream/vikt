import { Link } from "react-router-dom";
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CorrelationPane } from "shared";
import { expectedChangeKgPerWeek, formatDecimal, formatKcal, MIN_LOGGED_DAYS_PER_WEEK } from "shared";
import { OfflineNotice } from "../components/SyncIndicator.js";
import { useCorrelations } from "../lib/daily.js";
import { formatLongDay, todayLocalDate } from "../lib/dates.js";
import { useMe } from "../lib/session.js";
import { alpha, useTokens } from "../lib/tokens.js";
import { niceTicks } from "../lib/ticks.js";
import { LOCALE, plural, t, type TranslationKey } from "../i18n/index.js";

/**
 * The deep-dive screen. Allowed to be dense, and desktop-first — three scatters
 * side by side need width, and this is not a screen anyone opens while standing
 * in a kitchen.
 *
 * **It computes and shows no statistic (D34).** No r, no fitted line, no
 * "strong/weak", no causal language anywhere in the copy. Each pane shows its
 * points, how many days are in it, how many days it had to drop, and the dates
 * it covers. The reader draws their own conclusion, or fails to — which is
 * often the correct outcome for twenty-odd self-rated days.
 *
 * The pre-data state is designed rather than defaulted, the same way the
 * dashboard's was: it says how many days it has, how many it needs, and where
 * they come from. A pane with four points would look like a finding.
 */

type PaneMeta = {
  xLabel: TranslationKey;
  yLabel: TranslationKey;
  caption: TranslationKey;
  /** Decimals on the x axis. Sleep hours and kcal want different treatment. */
  xDecimals: number;
  yDecimals: number;
};

const PANES: Record<CorrelationPane["pane"], PaneMeta> = {
  sleep_energy: {
    xLabel: "corr.sleepHours",
    yLabel: "corr.energy",
    caption: "corr.sleepEnergyCaption",
    xDecimals: 1,
    yDecimals: 0,
  },
  activity_sweat: {
    xLabel: "corr.activityMinutes",
    yLabel: "corr.sweat",
    caption: "corr.activitySweatCaption",
    xDecimals: 0,
    yDecimals: 0,
  },
  intake_trend_change: {
    xLabel: "corr.meanIntake",
    yLabel: "corr.trendChangeWeek",
    caption: "corr.intakeTrendWeekCaption",
    xDecimals: 0,
    yDecimals: 2,
  },
};

/**
 * The correlation view, as a tab inside Data (D92).
 *
 * It used to be its own route with its own bottom-bar entry it never got, so on
 * a portrait phone it was unreachable except by typing the URL. Both screens are
 * views of the same logged series and both carry D34's constraints — no
 * coefficients, no fitted lines, no causal language — so one entry point with
 * two tabs is fewer things to place and one fewer screen to find.
 *
 * Exported as a component rather than a route: `Data` renders it, and the old
 * `/samband` path redirects there.
 */
export function Correlations() {
  const me = useMe();
  const timezone = me.data?.profile.timezone ?? "Europe/Stockholm";
  const today = todayLocalDate(timezone);
  const correlations = useCorrelations(today);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">{t("corr.title")}</h1>
          <p className="max-w-2xl text-note text-muted">{t("corr.subtitle")}</p>
        </div>
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("nav.dashboard")}
        </Link>
      </header>

      {correlations.isError ? <OfflineNotice what="correlations" /> : null}

      {correlations.isPending ? (
        <p role="status" className="text-note text-muted">
          {t("app.loading")}
        </p>
      ) : null}

      {correlations.data ? (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            {correlations.data.panes.map((pane) => (
              <PaneChart
                key={pane.pane}
                pane={pane}
                minPairs={correlations.data.minPairs}
                dailyLogDays={correlations.data.dailyLogDays}
              />
            ))}
          </div>

          {/*
            The standing caveat, on screen rather than in a decision file. It is
            deliberately not phrased as a warning about *these* charts being bad
            — it is what any chart of this kind can and cannot tell you.
          */}
          <p className="mt-8 max-w-3xl text-micro text-muted">{t("corr.caveat")}</p>
        </>
      ) : null}
    </main>
  );
}

export function PaneChart({
  pane,
  minPairs,
  dailyLogDays,
}: {
  pane: CorrelationPane;
  minPairs: number;
  dailyLogDays: number;
}) {
  const tokens = useTokens();
  const meta = PANES[pane.pane];

  /**
   * Round marks on both axes, for the same reason the trend chart has them: a
   * `dataMin`/`dataMax` domain divided evenly gives ticks like `-0,64 / -0,44 /
   * -0,24`, which no one reads as a scale.
   */
  const bounds = (pick: (pair: { x: number; y: number }) => number) => {
    const values = pane.pairs.map(pick);
    return values.length === 0
      ? ([0, 1] as const)
      : ([Math.min(...values), Math.max(...values)] as const);
  };

  const xBounds = bounds((pair) => pair.x);

  /**
   * The expected line's two ends, when there is a measured maintenance figure
   * (D166). Arithmetic on that figure and 7700 kcal per kg, evaluated at the
   * ends of the x axis, so it does not depend on a single point: it would be
   * the same line with none of them on the chart.
   */
  const reference = pane.reference;
  const expectedAt = (x: number) =>
    reference === null ? null : expectedChangeKgPerWeek(x, reference.maintenanceKcal);
  const lineEnds =
    reference === null
      ? null
      : ([
          { x: xBounds[0], y: expectedAt(xBounds[0])! },
          { x: xBounds[1], y: expectedAt(xBounds[1])! },
        ] as const);

  // The y axis holds the line as well as the points, so neither is clipped.
  const pointY = bounds((pair) => pair.y);
  const yBounds = lineEnds
    ? ([
        Math.min(pointY[0], lineEnds[0].y, lineEnds[1].y),
        Math.max(pointY[1], lineEnds[0].y, lineEnds[1].y),
      ] as const)
    : pointY;

  const xFormat = (value: number) => formatDecimal(value, { decimals: meta.xDecimals });
  const yFormat = (value: number) => formatDecimal(value, { decimals: meta.yDecimals });

  return (
    <section className="min-w-0 rounded-lg border border-edge p-4">
      <h2 className="text-note text-ink">
        {t(meta.yLabel)} <span className="text-muted">{t("corr.against")}</span>{" "}
        {t(meta.xLabel)}
      </h2>
      <p className="mt-1 text-micro text-muted">{t(meta.caption)}</p>

      {pane.enough ? (
        <>
          <div className="mt-4 h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              {/* See TrendChart: the layer adds `tabIndex={0}` and
                  `role="application"`, which draws a ring around the whole plot
                  on any click. */}
              <ScatterChart
                margin={{ top: 8, right: 12, bottom: 24, left: 0 }}
                accessibilityLayer={false}
                role="img"
                aria-label={t("corr.chartLabel", {
                  x: t(meta.xLabel),
                  y: t(meta.yLabel),
                  count: pane.pairs.length,
                })}
              >
                <CartesianGrid stroke={tokens.edge} />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={t(meta.xLabel)}
                  domain={[xBounds[0], xBounds[1]]}
                  ticks={niceTicks(xBounds[0], xBounds[1], 5, xFormat)}
                  stroke={tokens.muted}
                  tick={{ fill: tokens.muted, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    formatDecimal(value, { decimals: meta.xDecimals })
                  }
                  label={{
                    value: t(meta.xLabel),
                    position: "insideBottom",
                    offset: -14,
                    fill: tokens.muted,
                    fontSize: 11,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={t(meta.yLabel)}
                  domain={[yBounds[0], yBounds[1]]}
                  ticks={niceTicks(yBounds[0], yBounds[1], 5, yFormat)}
                  width={46}
                  stroke={tokens.muted}
                  tick={{ fill: tokens.muted, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    formatDecimal(value, { decimals: meta.yDecimals })
                  }
                />
                <Tooltip
                  cursor={{ stroke: tokens.edge }}
                  isAnimationActive={false}
                  content={<PointTooltip meta={meta} unit={pane.unit} />}
                />
                {/*
                  Points, and one dashed reference. There is still no <Line> in
                  this file and no fit (D34): a line through twenty self-rated
                  points would read as evidence, and it would not be any.

                  The reference is D166's, and a test holds it to being the only
                  one: what 7700 kcal per kg says a week at this intake should do,
                  from a measured maintenance figure. Sten and dashed, because it
                  is arithmetic about the points rather than one of them.
                */}
                {lineEnds ? (
                  <ReferenceLine
                    segment={[lineEnds[0], lineEnds[1]]}
                    stroke={tokens.uncertain}
                    strokeDasharray="5 4"
                    strokeWidth={1.5}
                    ifOverflow="extendDomain"
                  />
                ) : null}
                {/*
                  Fully opaque and outlined, unlike the trend chart's raw dots.
                  There the dots sit behind the line and stay quiet; here they
                  are the entire content of the card, and 84 of them at 0.45
                  alpha in a tight cluster read as an empty panel.
                */}
                <Scatter
                  data={pane.pairs}
                  fill={alpha(tokens.data, 0.9)}
                  stroke={tokens.paper}
                  strokeWidth={0.75}
                  shape="circle"
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>

          <dl className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-micro text-muted">
            <dt>{t(pane.unit === "week" ? "corr.sampleWeeks" : "corr.sampleSize")}</dt>
            <dd className="text-right text-ink">
              {formatDecimal(pane.sampleSize, { decimals: 0 })}
            </dd>
            {pane.range ? (
              <>
                <dt>{t("corr.range")}</dt>
                <dd className="text-right text-ink">
                  {t("corr.rangeValue", {
                    from: formatLongDay(pane.range.from, LOCALE),
                    to: formatLongDay(pane.range.to, LOCALE),
                  })}
                </dd>
              </>
            ) : null}
            {pane.unpairedDays > 0 ? (
              <>
                <dt>{t(pane.unit === "week" ? "corr.droppedWeeksLabel" : "corr.unpaired")}</dt>
                <dd className="text-right text-ink">
                  {formatDecimal(pane.unpairedDays, { decimals: 0 })}
                </dd>
              </>
            ) : null}
          </dl>

          {pane.unit === "week" ? <WeekNotes pane={pane} /> : null}
        </>
      ) : (
        <PreData pane={pane} minPairs={minPairs} dailyLogDays={dailyLogDays} />
      )}
    </section>
  );
}

/**
 * The pre-data state, designed rather than defaulted.
 *
 * It says exactly three things: how many days this pane has, how many it needs,
 * and what has to be logged to get there. No spinner, no empty axes, and no
 * four-point scatter that reads as a shape.
 */
function PreData({
  pane,
  minPairs,
  dailyLogDays,
}: {
  pane: CorrelationPane;
  minPairs: number;
  dailyLogDays: number;
}) {
  const needed = pane.needed ?? minPairs;
  const remaining = Math.max(0, needed - pane.sampleSize);

  /**
   * A weekly pane says "inte än" and how many whole weeks it has (D166). Weeks
   * rather than days, because a day is not a point here, and "12 dagar av 14"
   * would promise a chart two days away that is really two weeks away.
   */
  if (pane.unit === "week") {
    return (
      <div className="mt-4 flex h-[260px] flex-col justify-center rounded-md border border-dashed border-edge px-5 text-note">
        <p className="text-ink" data-testid="weeks-not-yet">
          {t("corr.notYetWeeks", { have: pane.sampleSize, need: needed })}
        </p>
        <p className="mt-2 text-micro text-muted">
          {t("corr.weekNeedsDays", { days: MIN_LOGGED_DAYS_PER_WEEK })}
        </p>
        {pane.unpairedDays > 0 ? (
          <p className="mt-2 text-micro text-muted">
            {t("corr.droppedWeeks", { weeks: pane.unpairedDays })}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-4 flex h-[260px] flex-col justify-center rounded-md border border-dashed border-edge px-5 text-note">
      <p className="text-ink">
        {pane.sampleSize === 0
          ? t("corr.noneYet")
          : pane.sampleSize === 1
            ? t("corr.oneYet", { need: needed })
            : t("corr.someYet", { have: pane.sampleSize, need: needed })}
      </p>
      <p className="mt-2 text-micro text-muted">
        {plural(remaining, "corr.oneMoreDay", "corr.moreDays")}
      </p>
      {pane.unpairedDays > 0 ? (
        <p className="mt-2 text-micro text-muted">
          {t("corr.halfLogged", { days: pane.unpairedDays })}
        </p>
      ) : null}
      {dailyLogDays === 0 ? (
        <p className="mt-3 text-micro text-muted">{t("corr.startLogging")}</p>
      ) : null}
    </div>
  );
}

/**
 * What the weekly pane has to say under its chart (D166): that the trend lags
 * the scale and the change was measured that much later, and what the dashed
 * line is, what distance from it means, and why a week near a change in intake
 * sits off it. Or, without a measured maintenance figure, why there is no line.
 */
function WeekNotes({ pane }: { pane: CorrelationPane }) {
  return (
    <div className="mt-3 space-y-2 text-micro text-muted" data-testid="week-notes">
      {pane.lagDays !== null ? <p>{t("corr.lagNote", { lag: pane.lagDays })}</p> : null}
      <p>
        {pane.reference
          ? t("corr.expectedNote", { maintenance: formatKcal(pane.reference.maintenanceKcal) })
          : t("corr.noExpected")}
      </p>
    </div>
  );
}

function PointTooltip({
  active,
  payload,
  meta,
  unit,
}: {
  active?: boolean;
  payload?: { payload: { localDate: string; x: number; y: number } }[];
  meta: PaneMeta;
  unit: CorrelationPane["unit"];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border border-edge bg-paper px-3 py-2 text-micro shadow-sm">
      <p className="text-muted">
        {unit === "week"
          ? t("corr.weekOf", { date: formatLongDay(point.localDate, LOCALE) })
          : formatLongDay(point.localDate, LOCALE)}
      </p>
      <p className="num mt-1 text-ink">
        {t(meta.xLabel)}: {formatDecimal(point.x, { decimals: meta.xDecimals })}
      </p>
      <p className="num text-ink">
        {t(meta.yLabel)}: {formatDecimal(point.y, { decimals: meta.yDecimals })}
      </p>
    </div>
  );
}
