import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { InsightsResponse, TrendPoint, WeightSource } from "shared";
import { formatDecimal } from "shared";
import { formatLongDay } from "../lib/dates.js";
import { alpha, usePrefersReducedMotion, useTokens } from "../lib/tokens.js";
import { niceTicks } from "../lib/ticks.js";
import { withTrendVertices } from "../lib/trend-series.js";
import { LOCALE, t } from "../i18n/index.js";

/**
 * The signature element (CLAUDE.md §5).
 *
 * One long, slow, downward line is what this product is about, so it gets the
 * hero position and everything else stays quiet around it:
 *
 *  - the trend is drawn in `--trend`, lingonberry, used for **nothing else**;
 *  - the raw readings and the waist-to-height series are both `--data`, ice.
 *    They are the same *kind* of thing — a secondary measurement behind the
 *    trend — and the profile gives that kind one colour. What tells them apart
 *    is the dash on the ratio line and the axis it hangs from, not a hue;
 *  - the raw daily readings are small faint dots in `--raw`, behind it as
 *    evidence rather than competing with it;
 *  - the two are different *marks* — a thick line against small dots — so the
 *    chart is readable without relying on colour;
 *  - **imported** readings are hollow rings rather than filled dots, because
 *    backfilled history is not the same claim as a morning on the scale.
 *
 * There is no failure state here. A day with no reading is a gap in the dots —
 * never red, never a marker of having slipped (CLAUDE.md §3).
 *
 * Waist-to-height (§4.4) rides the same time axis as a **toggleable** second
 * series, off by default. It frequently keeps moving when the scale stalls,
 * which is the entire point of having it — but two lines by default would cost
 * the trend its hero position, so it is opt-in, and drawn in `--logged` rather
 * than borrowing the lingonberry that belongs to the trend alone. It gets its
 * own right-hand axis: a ratio near 0.5 and a weight near 90 cannot share one.
 */

export type ChartPoint = TrendPoint & {
  /** Where the raw reading came from, when there is one. */
  source?: WeightSource | null;
};

export type TrendChartProps = {
  points: ChartPoint[];
  emptyMessage?: string;
  /** Smoothed waist-to-height on the same days, from `GET /api/insights`. */
  whtr?: InsightsResponse["whtr"];
  /** The rule-of-thumb reference line, passed in rather than hard-coded here. */
  whtrRuleOfThumb?: number;
  showWhtr?: boolean;
  onToggleWhtr?: (next: boolean) => void;
};

export function TrendChart({
  points,
  emptyMessage,
  whtr = [],
  whtrRuleOfThumb,
  showWhtr = false,
  onToggleWhtr,
}: TrendChartProps) {
  const tokens = useTokens();
  const reducedMotion = usePrefersReducedMotion();

  const domain = useMemo(() => yDomain(points), [points]);
  /**
   * One kilo per mark, not two.
   *
   * A window that spans six kilos took the first step that fits five marks,
   * which is 2, and an axis marked `86 / 88 / 90` cannot show the half-kilo
   * this product is about. Capped at 1 kg while the span is small enough for
   * that to stay readable; over ten kilos, "Allt" on a long history, one mark
   * per kilo would be twenty gridlines and the cap is dropped.
   */
  const ticks = useMemo(
    () => yTicks(domain, 6, domain[1] - domain[0] <= WIDE_DOMAIN_KG ? 1 : undefined),
    [domain],
  );
  const xAxisTicks = useMemo(() => xTicks(points), [points]);

  /**
   * Recharts renders one `<Scatter>` per series, so measured and imported
   * readings are split into two rather than branched inside a shape callback —
   * that also gives each its own legend entry and tooltip name for free.
   */
  const whtrByDay = useMemo(
    () => new Map(whtr.map((point) => [point.localDate, point])),
    [whtr],
  );

  /**
   * One row per day, and the trend **only on reading dates** (D144).
   *
   * `withTrendVertices` nulls the carried-forward days, and `connectNulls` on
   * the line below draws the monotone curve across them. The rows themselves
   * stay per-day because the x axis is categorical: dropping them would space
   * two readings a month apart the same as two a day apart.
   */
  const data = useMemo(
    () =>
      withTrendVertices(points).map((point) => {
        const ratio = whtrByDay.get(point.localDate);
        return {
          ...point,
          rawMeasured: point.source === "import" ? null : point.raw,
          rawImported: point.source === "import" ? point.raw : null,
          whtr: ratio?.whtr ?? null,
          whtrRaw: ratio?.raw ?? null,
        };
      }),
    [points, whtrByDay],
  );

  /** The toggle only exists once there is a waist history to toggle on. */
  const hasWhtr = whtr.length > 0;
  const whtrVisible = hasWhtr && showWhtr;
  const whtrDomain = useMemo(
    () => ratioDomain(whtr, whtrRuleOfThumb),
    [whtr, whtrRuleOfThumb],
  );

  if (points.length === 0) {
    return (
      <div
        className="flex h-48 items-center justify-center rounded-lg border border-dashed border-edge px-6 text-center text-note text-muted sm:h-72"
        role="status"
      >
        {emptyMessage ?? t("dash.nothingLogged")}
      </div>
    );
  }

  return (
    <figure className="m-0">
      {/*
        A fixed height, not 46vh: the hero element should not be 250 px on a
        short laptop and 500 px on a tall monitor.

        12rem on a phone, 18 from `sm`. The line is the hero and it is first on
        the page, but a hero that pushes the everyday actions below the fold has
        stopped being the top of a screen and become the whole of it: at
        360x667, the shortest phone this has to work on, the three quick actions
        sat 44 px under the bottom bar. A slow downward trend does not need
        vertical space to read as one — it needs room to the sides and nothing
        crowding it.
      */}
      <div className="h-48 w-full sm:h-72">
        <ResponsiveContainer width="100%" height="100%">
          {/*
            `accessibilityLayer` is off, which is what removes `tabIndex={0}`
            and `role="application"` from the SVG.

            Recharts adds both by default. The effect was a white ring around
            the whole plot area on any click, because a `role="application"`
            element matches `:focus-visible` on pointer focus in Chrome. §5
            wants visible focus on things that are genuinely interactive, and
            the range buttons and the waist toggle sit right next to this: a
            ring around a container nobody can operate teaches people to ignore
            the ring that means something.

            What it costs is Recharts' arrow-key traversal of the points. The
            trade is deliberate, and the chart says what it is instead: a
            `role="img"` with a label, which is a better answer for a screen
            reader than an application region with no documented keys.
          */}
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
            accessibilityLayer={false}
            role="img"
            aria-label={chartLabel(points)}
          >
            {/*
              Lighter than the axis text and lighter than it was. Gridlines are
              a reading aid for the line, not a structure the line sits inside,
              and at 0.6 they were competing with the raw dots.
            */}
            <CartesianGrid stroke={alpha(tokens.edge, 0.35)} vertical={false} />
            <XAxis
              dataKey="localDate"
              ticks={xAxisTicks}
              tickFormatter={formatDay}
              stroke={tokens.muted}
              // 10px and dimmer: dates are orientation, not content.
              tick={{ fill: alpha(tokens.muted, 0.75), fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              domain={domain}
              ticks={ticks}
              interval={0}
              width={36}
              stroke={tokens.muted}
              tick={{ fill: alpha(tokens.muted, 0.75), fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatKg}
            />
            {whtrVisible ? (
              <YAxis
                yAxisId="whtr"
                orientation="right"
                domain={whtrDomain}
                width={40}
                stroke={tokens.data}
                tick={{ fill: alpha(tokens.data, 0.75), fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatRatio}
              />
            ) : null}
            <Tooltip
              cursor={{ stroke: tokens.edge }}
              content={<TrendTooltip showWhtr={whtrVisible} />}
              // Follow the crosshair. Without an explicit position Recharts
              // parks a custom `content` element at the container's origin.
              allowEscapeViewBox={{ x: false, y: true }}
              offset={12}
              isAnimationActive={false}
            />

            {/*
              Readings first, so the trend line draws on top of them.

              Small and quiet on purpose. At 0.85 alpha and default radius a
              90-day window puts ninety filled circles over the line, and the
              hero element of the whole product loses to its own evidence
              (§5). Half the size and half the opacity keeps them legible as a
              cloud without competing.
            */}
            <Scatter
              dataKey="rawMeasured"
              name={t("chart.reading")}
              fill={alpha(tokens.data, 0.45)}
              shape="circle"
              legendType="circle"
              isAnimationActive={false}
              r={2}
            />
            <Scatter
              dataKey="rawImported"
              name={t("chart.imported")}
              // Hollow: backfilled history, visibly not a measurement taken then.
              fill="none"
              stroke={alpha(tokens.data, 0.55)}
              strokeWidth={1}
              shape="circle"
              isAnimationActive={false}
              r={2}
            />
            {/*
              The signature element. Thicker than anything else on the page and
              in the one colour reserved for it (§5), with round joins so a long
              slow curve reads as a single continuous line rather than as a
              polyline of daily segments.
            */}
            <Line
              dataKey="trend"
              name={t("chart.trend")}
              /*
                Monotone, and the choice matters now that the vertices are
                sparse. A natural cubic through a nine-day gap overshoots the
                lower reading on its way there, drawing a weight nobody
                recorded; monotone cannot leave the interval between two
                neighbouring values.
              */
              type="monotone"
              stroke={tokens.trend}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, fill: tokens.trend, stroke: tokens.paper, strokeWidth: 2 }}
              isAnimationActive={!reducedMotion}
              animationDuration={400}
              // The gap days carry no vertex (D144); the curve spans them.
              connectNulls
            />

            {/*
              The same treatment as the weight series, for the same reason
              (D32): the smoothed ratio is the line, the measured points sit
              behind it as evidence. A hand-held tape carries about ±1 cm, so a
              raw waist series alone is largely a picture of how tightly it was
              pulled on the day.
            */}
            {whtrVisible ? (
              <Scatter
                yAxisId="whtr"
                dataKey="whtrRaw"
                name={t("chart.whtrReading")}
                fill={alpha(tokens.data, 0.45)}
                shape="circle"
                isAnimationActive={false}
              />
            ) : null}
            {whtrVisible ? (
              <Line
                yAxisId="whtr"
                dataKey="whtr"
                name={t("chart.whtr")}
                type="monotone"
                stroke={tokens.data}
                strokeWidth={2}
                // Dashed as well as differently coloured, so the two lines are
                // still distinguishable without relying on colour (§5).
                strokeDasharray="5 3"
                dot={false}
                activeDot={{
                  r: 4,
                  fill: tokens.data,
                  stroke: tokens.paper,
                  strokeWidth: 2,
                }}
                isAnimationActive={!reducedMotion}
                animationDuration={400}
                connectNulls
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/*
        The legend and the waist toggle on one row rather than two.

        They are both chart chrome, they are both one line tall, and stacking
        them cost 28 px directly above the figure the chart is a picture of.
        Wraps to two rows on its own when the legend grows a third entry.
      */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-2 text-micro text-muted">
        <span className="inline-flex items-center gap-2">
          <svg width="18" height="8" aria-hidden="true">
            <line
              x1="0"
              y1="4"
              x2="18"
              y2="4"
              stroke={tokens.trend}
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
          {t("chart.trend")}
        </span>
        <span className="inline-flex items-center gap-2">
          <svg width="18" height="8" aria-hidden="true">
            <circle cx="9" cy="4" r="2" fill={alpha(tokens.data, 0.45)} />
          </svg>
          {t("chart.reading")}
        </span>
        {whtrVisible ? (
          <span className="inline-flex items-center gap-2">
            <svg width="18" height="8" aria-hidden="true">
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke={tokens.data}
                strokeWidth="2"
                strokeDasharray="5 3"
              />
            </svg>
            {t("chart.whtr")}
          </span>
        ) : null}
        {/*
          The imported chip is gone. Hollow rings are still drawn differently
          from filled dots and the tooltip on one says "importerad" in words, so
          a fourth legend entry was chrome explaining a distinction the chart
          already makes on the point itself.
        */}
      </figcaption>

      {hasWhtr && onToggleWhtr ? (
        <label className="inline-flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={showWhtr}
            onChange={(event) => onToggleWhtr(event.target.checked)}
            className="check"
          />
          {t("chart.showWhtr")}
        </label>
      ) : null}
      </div>
    </figure>
  );
}

/**
 * What the chart says, in one sentence, for anyone who cannot see it.
 *
 * The span and the direction, not a list of points: a screen reader reading
 * ninety daily weights is worse than no chart at all, and the readings are
 * available as a list further down the page.
 */
function chartLabel(points: readonly TrendPoint[]): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return t("chart.emptyLabel");

  return t("chart.summary", {
    from: formatDecimal(first.trend, { decimals: 1 }),
    to: formatDecimal(last.trend, { decimals: 1 }),
    days: points.length,
  });
}

/**
 * A band for the ratio axis. Padded like the weight axis, and widened to keep
 * the rule of thumb inside the view when the line runs close to it — a
 * reference clipped off the top of the chart is worse than none.
 */
function ratioDomain(
  points: readonly { whtr: number }[],
  ruleOfThumb: number | undefined,
): [number, number] {
  const values = points.map((point) => point.whtr).filter(Number.isFinite);
  if (values.length === 0) return [0, 1];

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (ruleOfThumb !== undefined && Math.abs(min - ruleOfThumb) < 0.05) {
    min = Math.min(min, ruleOfThumb);
    max = Math.max(max, ruleOfThumb);
  }

  const padding = Math.max((max - min) * 0.25, 0.01);
  return [roundRatio(min - padding), roundRatio(max + padding)];
}

const roundRatio = (value: number) => Math.round(value * 1000) / 1000;

const formatRatio = (value: number) => formatDecimal(value, { decimals: 2 });

function formatDay(localDate: string): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

/**
 * One decimal, which is also the precision the tick de-duplication works at.
 * Goes through the shared formatter so the axis reads `87,3` like everything
 * else rather than `87.3`.
 */
const formatKg = (value: number) => formatDecimal(value, { decimals: 1, grouping: false });

/**
 * The y-domain is taken from the **trend** series, not from the readings.
 *
 * The trend is the hero (§5). Letting a couple of outlying raw readings set the
 * bounds squashed a real 4 kg move into the middle quarter of the plot, which is
 * exactly backwards: the noisy points are the thing that should be allowed to
 * sit near the edges, and the line is the thing that should fill the space.
 *
 * Raw points outside the domain are clipped rather than clamped, so nothing is
 * drawn at a value it does not have.
 */
export function yDomain(points: readonly TrendPoint[]): [number, number] {
  const trends = points.map((point) => point.trend).filter(Number.isFinite);
  if (trends.length === 0) return [0, 1];

  /**
   * Every raw reading in the window is inside the domain.
   *
   * This used to bound the axis by the **trend alone**, on the reasoning that
   * the line is the hero and a couple of outlying readings should not squash
   * it into the middle quarter of the plot. That reasoning was right about the
   * hero and wrong about the arithmetic: the trend is an exponential moving
   * average, so it lags, and on a real series it sits well inside the readings
   * that produced it. A morning weigh-in of 106,9 against a trend still at
   * 108,4 landed outside a domain built from the trend and was clipped —
   * the most recent reading, the one a person opens the app to see, simply not
   * drawn.
   *
   * Clipping made it invisible rather than wrong, which is why it survived: the
   * chart looked fine, and the missing point looked like a day nobody logged.
   *
   * The line stays readable because the two series are not independent. The
   * trend is drawn from these readings, so it runs through the middle of them
   * by construction, and widening to hold them costs the line the noise band
   * around it rather than half the plot.
   */
  const readings = points
    .map((point) => point.raw)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const values = [...trends, ...readings];
  const min = Math.min(...values);
  const max = Math.max(...values);

  /**
   * Padding proportional to the **trend's** spread, not the combined one, so a
   * single noisy morning widens the domain by its own distance and not by a
   * quarter of itself again. A flat line still needs a band to sit in, or it
   * lands on the axis.
   */
  const trendSpread = Math.max(...trends) - Math.min(...trends);
  const padding = Math.max(trendSpread * 0.2, (max - min) * 0.06, 0.3);

  return [round(min - padding), round(max + padding)];
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * Round y ticks inside a domain that is not round.
 *
 * The domain comes from the data plus padding, so dividing it into equal parts
 * gave `85,6 / 87,5 / 89,4 / 91,3 / 93,2`: evenly spaced, all correct, and all
 * meaningless. An axis is a ruler, and a ruler is marked at halves and whole
 * numbers rather than at whatever the data happened to span.
 *
 * So a step is chosen from a 1 / 2 / 2.5 / 5 progression, the smallest that
 * yields no more than `count` marks, and the ticks are the multiples of it that
 * fall inside the domain. The de-duplication guarantee is kept: two ticks that
 * render as the same string collapse to one, which is what stopped "108"
 * appearing twice when this was first written.
 */
export function yTicks(
  domain: readonly [number, number],
  count = 5,
  maxStep?: number,
): number[] {
  /**
   * `KG_QUANTUM` is what makes the marks evenly spaced *as printed*. The labels
   * carry one decimal, so a step has to be a whole number of tenths — see
   * `candidateSteps` in ticks.ts, which this axis is the reason for.
   */
  return niceTicks(domain[0], domain[1], count, formatKg, maxStep, KG_QUANTUM);
}

/** One decimal is the precision `formatKg` prints at, so 0.1 kg is the quantum. */
const KG_QUANTUM = 0.1;

/**
 * Above this span the one-kilo cap is dropped. Ten kilos at one mark each is
 * already eleven gridlines; twenty would be a ruler with no line on it.
 */
export const WIDE_DOMAIN_KG = 10;

/**
 * At most five x ticks, evenly spaced, always including the last day.
 *
 * Was eight. On a 360 px screen eight dates are almost touching, and the axis
 * is there to say roughly when, not to be read off.
 */
function xTicks(points: readonly TrendPoint[]): string[] {
  if (points.length <= 5) return points.map((point) => point.localDate);
  const step = Math.ceil(points.length / 4);
  const ticks: string[] = [];
  for (let i = points.length - 1; i >= 0; i -= step) ticks.unshift(points[i]!.localDate);
  return ticks;
}

function TrendTooltip({
  active,
  payload,
  showWhtr,
}: {
  active?: boolean;
  payload?: { payload: ChartPoint & { whtr?: number | null } }[];
  showWhtr?: boolean;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  /**
   * Reading dates only (D144).
   *
   * A day that carried the trend forward has nothing to report: the weight is
   * unknown and the trend figure is the previous reading's, restated. Showing
   * it invited the reading that the staircase already suggested, that the
   * number held steady across the gap. What actually happened there is that
   * nobody weighed, and the honest tooltip for that is none.
   */
  if (point.raw === null) return null;

  const readingLine =
    point.source === "import"
        ? t("chart.importedValue", { value: formatDecimal(point.raw, { decimals: 1 }) })
        : t("chart.readValue", { value: formatDecimal(point.raw, { decimals: 1 }) });

  return (
    <div className="rounded-lg border border-edge bg-card px-3 py-2 text-note shadow-lg">
      <p className="text-micro text-muted">{formatLongDay(point.localDate, LOCALE)}</p>
      {/*
        One decimal, like the headline trend weight and like the axis. The
        tooltip carried two, so tapping the chart turned 86,9 into 86,93 and
        invited a reader to believe the second digit. The trend is an average
        over a fortnight of scale readings that are themselves ±0.1 at best;
        the second decimal is arithmetic, not measurement, and §5's rule that
        uncertainty is never dressed up applies to precision as much as colour.
      */}
      <p className="num mt-1 text-metric-sm text-ink">
        {t("chart.trendValue", { value: formatDecimal(point.trend, { decimals: 1 }) })}
      </p>
      <p className="num text-muted">{readingLine}</p>
      {showWhtr && typeof point.whtr === "number" ? (
        <p className="num text-muted">
          {t("chart.whtrValue", { value: formatDecimal(point.whtr, { decimals: 3 }) })}
        </p>
      ) : null}
    </div>
  );
}
