import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDecimal } from "shared";
import { formatDayMonth, formatLongDay } from "../lib/dates.js";
import { alpha, useTokens } from "../lib/tokens.js";
import { niceTicks } from "../lib/ticks.js";
import { LOCALE, t } from "../i18n/index.js";

/**
 * One logged series, plotted over time.
 *
 * A **viewer, not an analysis** (D34). What this deliberately does not do:
 *
 * - no correlation coefficient, no r, no p, no "strength";
 * - no fitted line, no trend line, no regression of any kind;
 * - no smoothing of a self-reported scale. A 1-5 answer is a person picking one
 *   of five words, and drawing a curve through it implies a resolution it does
 *   not have. Scales are points; nothing joins them;
 * - no causal language anywhere in the copy. "Sömn" and "Energi" sit side by
 *   side because someone wants to look at them, not because the app is
 *   suggesting one causes the other.
 *
 * What it does do is say what it is showing: the range, and how many days
 * inside it actually carry this series. A sparse series that looks continuous
 * is the quiet way a viewer starts lying.
 */

export type SeriesPoint = {
  localDate: string;
  value: number | null;
};

export type SeriesPanelProps = {
  title: string;
  /** Shown after the count, e.g. "h" or "kcal". Empty for a bare scale. */
  unit?: string;
  points: SeriesPoint[];
  /**
   * Three shapes, because three kinds of thing are being shown.
   *
   * `scale` is a self-reported 1-5 answer: points on a fixed 1-5 axis, never
   * joined and never smoothed. The axis is fixed rather than fitted so a week
   * of 3s and 4s does not fill the panel and read as a swing.
   *
   * `amount` is something counted — steps, kcal, minutes, drinks — and gets
   * bars from zero, because zero is meaningful for all of them.
   *
   * `measure` is something measured on the days it was measured, like a waist.
   * Points, not bars, because it is not a quantity accumulated that day; and a
   * fitted axis, because a waist plotted from zero is a flat line at the top of
   * an empty panel.
   */
  kind: "scale" | "amount" | "measure";
  /** Decimals for the value in the tooltip and on the axis. */
  decimals?: number;
  /** A `--logged`, `--raw` or `--muted` token, so panels are distinguishable. */
  tone?: "data" | "nutrition";
};

export function SeriesPanel({
  title,
  unit = "",
  points,
  kind,
  decimals = 0,
  tone = "data",
}: SeriesPanelProps) {
  const tokens = useTokens();
  /**
   * Every series is Is, and intake is the one exception (profile, page 8).
   *
   * "Ingen serie får en egen färg, etiketten skiljer dem": eleven series in
   * eleven colours would be a legend to memorise, and the panels already carry
   * their own titles. Intake gets Blåbär because it genuinely is the nutrition
   * area, not because it is more important.
   */
  const colour = tone === "nutrition" ? tokens.nutrition : tokens.data;

  /** Days that actually carry a value. The rest are absent, not zero (D44). */
  const present = useMemo(
    () => points.filter((point) => point.value !== null),
    [points],
  );

  const domain = useMemo<[number, number]>(() => {
    if (kind === "scale") return [1, 5];

    const values = present.map((point) => point.value!);
    if (values.length === 0) return [0, 1];

    const max = Math.max(...values);
    if (kind === "amount") return [0, max === 0 ? 1 : max * 1.1];

    // `measure`: fitted with padding, and a flat series still gets a band to
    // sit in rather than landing on the axis.
    const min = Math.min(...values);
    const padding = Math.max((max - min) * 0.25, 0.5);
    return [min - padding, max + padding];
  }, [kind, present]);

  const ticks = useMemo(
    () =>
      kind === "scale"
        ? [1, 2, 3, 4, 5]
        : niceTicks(domain[0], domain[1], 4, (value) =>
            formatDecimal(value, { decimals, grouping: false }),
          ),
    [kind, domain, decimals],
  );

  /** Points for a scale or a measure; bars only for a counted amount. */
  const asPoints = kind !== "amount";

  const xTicks = useMemo(() => pickXTicks(points), [points]);

  const format = (value: number) => formatDecimal(value, { decimals });

  return (
    <section className="panel" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-note text-ink">{title}</h3>
        {/*
          How much of the window this series covers, always. A panel with four
          points spread over ninety days looks like a sparse chart; saying "4 av
          90 dagar" is the difference between the reader knowing that and
          guessing it.
        */}
        <p className="num text-micro text-muted">
          {t("data.coverage", { days: present.length, total: points.length })}
          {unit === "" ? "" : ` · ${unit}`}
        </p>
      </div>

      {present.length === 0 ? (
        <p className="mt-4 text-note text-muted">{t("data.noneInRange")}</p>
      ) : (
        <div data-swipe-ignore className="mt-3 h-40 w-full">
          {/* The same as the trend line: a drag across a series is reading it (D154). */}
          <ResponsiveContainer width="100%" height="100%">
            {asPoints ? (
              <ScatterChart
                data={points}
                margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                accessibilityLayer={false}
                role="img"
                aria-label={t("data.chartLabel", { name: title, days: present.length })}
              >
                <CartesianGrid stroke={alpha(tokens.edge, 0.35)} vertical={false} />
                <XAxis
                  dataKey="localDate"
                  ticks={xTicks}
                  tickFormatter={(value: string) => formatDayMonth(value, LOCALE)}
                  stroke={tokens.muted}
                  tick={{ fill: alpha(tokens.muted, 0.75), fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={20}
                />
                <YAxis
                  dataKey="value"
                  domain={domain}
                  ticks={ticks}
                  interval={0}
                  width={kind === "scale" ? 26 : 48}
                  tickFormatter={format}
                  stroke={tokens.muted}
                  tick={{ fill: alpha(tokens.muted, 0.75), fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  cursor={{ stroke: tokens.edge }}
                  isAnimationActive={false}
                  content={<PointTooltip format={format} unit={unit} />}
                />
                {/*
                  Points, never a line. Joining five discrete self-reported
                  answers would draw values nobody gave on days nobody answered.
                */}
                <Scatter
                  dataKey="value"
                  fill={alpha(colour, 0.85)}
                  stroke={tokens.paper}
                  strokeWidth={0.75}
                  shape="circle"
                  isAnimationActive={false}
                />
              </ScatterChart>
            ) : (
              <BarChart
                data={points}
                margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
                accessibilityLayer={false}
                role="img"
                aria-label={t("data.chartLabel", { name: title, days: present.length })}
              >
                <CartesianGrid stroke={alpha(tokens.edge, 0.35)} vertical={false} />
                <XAxis
                  dataKey="localDate"
                  ticks={xTicks}
                  tickFormatter={(value: string) => formatDayMonth(value, LOCALE)}
                  stroke={tokens.muted}
                  tick={{ fill: alpha(tokens.muted, 0.75), fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={20}
                />
                <YAxis
                  domain={domain}
                  ticks={ticks}
                  // Wide enough for a grouped five-figure step count.
                  width={48}
                  stroke={tokens.muted}
                  tick={{ fill: alpha(tokens.muted, 0.75), fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={format}
                />
                <Tooltip
                  cursor={{ fill: alpha(tokens.edge, 0.4) }}
                  isAnimationActive={false}
                  content={<PointTooltip format={format} unit={unit} />}
                />
                {/*
                  A bar per day. A day with nothing logged has no bar rather
                  than a zero-height one, which is the same distinction the rest
                  of the app makes between absent and none.
                */}
                <Bar dataKey="value" fill={alpha(colour, 0.75)} isAnimationActive={false} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

/** At most five date ticks, evenly spaced, always including the last day. */
function pickXTicks(points: readonly SeriesPoint[]): string[] {
  if (points.length <= 5) return points.map((point) => point.localDate);
  const step = Math.ceil(points.length / 4);
  const ticks: string[] = [];
  for (let i = points.length - 1; i >= 0; i -= step) ticks.unshift(points[i]!.localDate);
  return ticks;
}

function PointTooltip({
  active,
  payload,
  format,
  unit,
}: {
  active?: boolean;
  payload?: { payload: SeriesPoint }[];
  format: (value: number) => string;
  unit: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border border-edge bg-card px-3 py-2 text-micro shadow-lg">
      <p className="text-muted">{formatLongDay(point.localDate, LOCALE)}</p>
      <p className="num mt-1 text-ink">
        {point.value === null
          ? t("data.notLogged")
          : `${format(point.value)}${unit === "" ? "" : ` ${unit}`}`}
      </p>
    </div>
  );
}
