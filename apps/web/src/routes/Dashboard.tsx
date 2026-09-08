import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  addDays,
  bmiBand,
  computeTrend,
  formatDecimal,
  formatKg,
  type WeightEntry,
} from "shared";
import { useLogout, useMe } from "../lib/session.js";
import { useDeleteWeight, useInsights, useWeightLog } from "../lib/log.js";
import { formatLongDay, todayLocalDate } from "../lib/dates.js";
import { TrendChart, type ChartPoint } from "../components/TrendChart.js";
import { QuickLogSheet } from "../components/QuickLogSheet.js";
import { RangeSelector, rangeDays, type RangeKey } from "../components/RangeSelector.js";
import { InsightsPanel } from "../components/InsightsPanel.js";
import { DayCard } from "../components/DayCard.js";
import { WelcomeCard } from "../components/WelcomeCard.js";
import { Disclosure } from "../components/Disclosure.js";
import { QuickActions, quickActions } from "../components/QuickActions.js";
import { DeleteButton } from "../components/DeleteButton.js";
import { Tooltip } from "../components/Tooltip.js";
import { OfflineNotice } from "../components/SyncIndicator.js";
import { PlanReviewNotice } from "../components/PlanReviewNotice.js";
import { LOCALE, t, type TranslationKey } from "../i18n/index.js";
import { HeaderLockup } from "../components/Wordmark.js";

/**
 * The dashboard.
 *
 * The line is the hero and everything else stays quiet around it (CLAUDE.md
 * §5). Deliberately *not* chopped into a grid of identical rounded cards: one
 * headline number, three actions, the chart, then today.
 *
 * Order, and why: **the line first**. §5 calls it the signature element and the
 * hero position is the top of the page, not the second screenful; a figure with
 * the chart under it made the number the subject and the line its footnote. The
 * trend weight sits directly beneath as the figure that line resolves to, then
 * the three quick actions, because that is the order of the question: how is it
 * going, what is it now, what do I do about it.
 *
 * The quick actions must stay reachable without scrolling at 360 px, since they
 * are the everyday path. That is what caps the chart at 14rem.
 *
 * Today's card is a different question — what happened today rather than where
 * the line is going — so it is its own card rather than another row in a grid.
 */

/**
 * Days of history after which the "smoothed over" note is dropped. At 21 days
 * the first reading still carries about 11% of the trend; beyond that the
 * headline is a smoothing of recent data rather than partly an echo of where
 * the user started. See DECISIONS.md D22.
 */
export const SMOOTHING_NOTE_DAYS = 21;

/** How many readings the list under the chart shows. */
const RECENT_READINGS = 5;

export function Dashboard() {
  const me = useMe();
  const logout = useLogout();
  const weightLog = useWeightLog();

  const [range, setRange] = useState<RangeKey>("90");
  /**
   * Off by default. Waist-to-height earns its place on this chart (§4.4) but
   * two lines at once would cost the trend its hero position (§5), so it is
   * something the reader asks for.
   */
  const [showWhtr, setShowWhtr] = useState(false);
  /**
   * The bottom bar's primary action is a link to `/?logga` rather than shared
   * state, so it works from a cold start and from any screen. Seeding the sheet
   * from the URL is what makes that one tap instead of two.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [logOpen, setLogOpen] = useState(() => searchParams.has("logga"));

  /**
   * Seeding the state on mount is not enough: tapping the bar's primary action
   * while already on the dashboard navigates to `/?logga` without remounting
   * this component, so the initialiser never runs again and the tap does
   * nothing. Watching the parameter is what makes the action work from every
   * screen including this one.
   */
  useEffect(() => {
    if (searchParams.has("logga")) setLogOpen(true);
  }, [searchParams]);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const deleteWeight = useDeleteWeight();
  const navigate = useNavigate();

  const profile = me.data?.profile;
  const timezone = profile?.timezone ?? "Europe/Stockholm";
  const today = todayLocalDate(timezone);
  const insights = useInsights(today);

  const readings: WeightEntry[] = weightLog.data ?? [];

  /**
   * The last few, newest first. Deliberately short: the chart is the hero (§5)
   * and a full ledger under it would compete with the line for attention.
   */
  const recentReadings = useMemo(
    () => [...readings].slice(-RECENT_READINGS).reverse(),
    [readings],
  );

  /**
   * The EMA is seeded from the *first ever* reading and then windowed, not
   * recomputed from the left edge of the window. Re-seeding per range would
   * make the same day show a different trend at 30 days and at 365, which is
   * both wrong and obviously wrong to anyone who switches between them.
   */
  const allPoints = useMemo<ChartPoint[]>(() => {
    const bySource = new Map(readings.map((entry) => [entry.localDate, entry.source]));
    return computeTrend(
      readings.map((entry) => ({
        localDate: entry.localDate,
        weightKg: entry.weightKg,
      })),
      { to: today },
    ).map((point) => ({ ...point, source: bySource.get(point.localDate) ?? null }));
  }, [readings, today]);

  /**
   * Windowed with the same bounds as the weight series, so the two share an
   * axis exactly. The smoothing itself is done on the server, over the whole
   * history, for the same reason the trend is: re-seeding per range would make
   * one day read differently at 30 days and at 365.
   */
  const whtrInRange = useMemo(() => {
    const series = insights.data?.whtr ?? [];
    const days = rangeDays(range);
    if (days === null) return series;
    const from = addDays(today, -(days - 1));
    return series.filter((point) => point.localDate >= from);
  }, [insights.data?.whtr, range, today]);

  const points = useMemo(() => {
    const days = rangeDays(range);
    if (days === null) return allPoints;
    const from = addDays(today, -(days - 1));
    return allPoints.filter((point) => point.localDate >= from);
  }, [allPoints, range, today]);

  const current = allPoints.at(-1) ?? null;
  const windowStart = points[0] ?? null;
  const change =
    current && windowStart && points.length > 1 ? current.trend - windowStart.trend : null;

  const lastReading = readings.at(-1) ?? null;
  /**
   * Today's intake comes from the server, resolved by `calc/intake.ts` (manual
   * row, else the day's food entries, else absent).
   *
   * This used to search `manual_intake` from the client and call the result
   * the day's intake, which is a second definition of a logged day living in a
   * second place. It said "Inte än" on days with a full food log.
   */
  const todayIntakeKcal = insights.data?.todayIntakeKcal ?? null;
  const loggedToday = lastReading?.localDate === today;

  // Days of history, which is the right measure under the time-aware alpha.
  const daysOfHistory = allPoints.length;
  const showSmoothingNote = daysOfHistory > 0 && daysOfHistory < SMOOTHING_NOTE_DAYS;

  /**
   * Scanning and food logging are links into the food screen; weight opens the
   * sheet in place, because the weight form is three fields and a modal is
   * cheaper than a navigation for it.
   */
  const actions = quickActions({ onLogWeight: () => setLogOpen(true) });

  if (!me.data) return null;

  return (
    <div className="min-h-dvh pb-10">
      <main className="mx-auto w-full max-w-3xl px-5 py-8">
        <header className="mb-8 flex items-baseline justify-between gap-4">
          {/*
            The wordmark alone, at 20 pt (profile, page 7). Never the mark here:
            it would compete with the graph directly beneath it.
          */}
          <h1>
            <HeaderLockup />
          </h1>
          {/*
            Sign out only. Every destination that used to live here is in the
            shell's sidebar on desktop and its bottom bar on mobile, so
            repeating them gave the page two navigations and wrapped "Logga ut"
            onto a second line at 360 px.
          */}
          <button
            type="button"
            className="text-note text-muted underline underline-offset-4"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            {t("auth.signOut")}
          </button>
        </header>

        <section aria-label={t("dash.trendOverTime")}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <RangeSelector value={range} onChange={setRange} />
            {lastReading ? (
              <p className="num text-micro text-muted">
                {t("dash.lastReading", { weight: formatKg(lastReading.weightKg) })}
              </p>
            ) : null}
          </div>

          {weightLog.isPending ? (
            <div
              className="h-48 animate-pulse rounded-lg bg-edge/40 sm:h-72"
              role="status"
              aria-label={t("dash.loadingTrend")}
            />
          ) : (
            <TrendChart
              points={points}
              emptyMessage={
                readings.length === 0 ? t("dash.nothingLogged") : t("dash.nothingInRange")
              }
              whtr={whtrInRange}
              whtrRuleOfThumb={insights.data?.whtrRuleOfThumb}
              showWhtr={showWhtr}
              onToggleWhtr={setShowWhtr}
            />
          )}
        </section>

        {/*
          The headline figure and the three actions, in one card.

          Two changes from the loose version. **Centred**, because a figure that
          large left-aligned under a full-width chart reads as a caption hanging
          off the corner; centred it reads as the chart's conclusion, which is
          what it is. **A card**, because everything else down this page is one,
          and a page of cards with two loose blocks floating between them looks
          like the loose blocks failed to load.

          Figure and actions share the card rather than taking one each: they
          are one unit — here is where you are, here is what you do about it —
          and splitting them would put a border between a question and its
          answer.
        */}
        {/*
          The whole of onboarding (D105). Above the trend figure because it is
          the first thing on a new account and nothing above it would be true
          yet, and gone by itself once its three suggestions are done.
        */}
        <WelcomeCard
          hasWeight={readings.length > 0}
          hasHeight={profile?.heightCm != null}
          hasPlan={insights.data?.goalWeightKg != null}
        />

        <section className="panel mb-6 mt-4 text-center">
          <p className="text-note text-muted">{t("dash.trendWeight")}</p>
          {/*
            No reading yet is said, not dashed (D101). The unit goes with the
            figure rather than standing beside an absence: "Inte än kg" is not a
            thing anybody says, and a lone "kg" under a missing number reads as a
            value that failed to load.
          */}
          <p className="num mt-0.5 text-figure text-ink">
            {current ? (
              <>
                {formatKg(current.trend)}
                <span className="ml-2 align-baseline text-metric-sm font-normal text-muted">
                  kg
                </span>
              </>
            ) : (
              <span className="text-muted">{t("stat.notYet")}</span>
            )}
          </p>

          {change !== null ? (
            <p className="num mt-1.5 text-note text-muted">
              {change <= 0 ? "↓" : "↑"}{" "}
              {t("dash.changeOver", {
                amount: formatDecimal(Math.abs(change), { decimals: 2 }),
                days: points.length,
              })}
            </p>
          ) : (
            <p className="mt-1.5 text-note text-muted">
              {readings.length === 0 ? t("dash.startLine") : t("dash.needMore")}
            </p>
          )}

          {/*
            Why the headline can sit away from this morning's reading. Dropped
            once the trend no longer leans on its seed — see D22.
          */}
          {showSmoothingNote ? (
            <p className="mx-auto mt-1.5 max-w-prose text-micro text-muted">
              {t("dash.smoothedOver", { days: daysOfHistory })}
            </p>
          ) : null}

        </section>

        {/*
          The three things this app is opened to do, as their own row.

          Not on a card, and not inside the trend weight's. A card is a claim
          that its contents are one thing to read; these are three controls to
          press, and boxing them made them look like data about the figure above
          them. Loose under the card is what a row of actions looks like
          everywhere else on a phone.
        */}
        <div className="mb-8">
          <QuickActions actions={actions} />
        </div>

        {/*
          Today: eaten, remaining, and the macros against NNR's targets (D52).
          Its own card because it is a different question from the trend — what
          happened today rather than where the line is going — and §5 asks for
          one idea per card.
        */}
        {insights.data ? (
          <div className="mt-8">
            <DayCard insights={insights.data} onLogFood={() => navigate("/food")} />
          </div>
        ) : null}

        {/*
          Maintenance has moved under the active plan (D25). Shown above the
          numbers it affects, and dismissable — the plan is the user's to change.
        */}
        {insights.data?.planReview && !reviewDismissed ? (
          <div className="mt-8">
            <PlanReviewNotice
              review={insights.data.planReview}
              targetIntakeKcal={insights.data.targetIntakeKcal}
              onDismiss={() => setReviewDismissed(true)}
            />
          </div>
        ) : null}

        {/*
          D43. Three states, and the middle one is the point: a maintenance
          figure that could not be fetched is **absent and says so**, never a
          cached number presented as current and never a spinner that hangs.
          The trend line above this is drawn from local data and keeps working,
          which is why the notice says what still does rather than only what
          does not.
        */}
        {/*
          Second tier. One quiet surface holds maintenance, the target and the
          projections together, so they read as a group rather than as three
          more headlines competing with the figure above. Deliberately one
          panel and not three cards (§5).
        */}
        <div className="panel mt-8">
          {insights.data ? (
            <InsightsPanel insights={insights.data} />
          ) : insights.isError ? (
            <OfflineNotice what="insights" />
          ) : insights.isPending ? (
            <p role="status" className="text-note text-muted">
              {t("stat.loading")}
            </p>
          ) : null}
        </div>

        {/*
          Reference figures, as a card rather than a loose row under a rule.

          Everything else on this page is a card with a border and a background;
          this was four numbers floating under a hairline, which read as a
          footer rather than as content. It holds one idea — what is true about
          this body right now — which is what earns it the same surface as the
          others.
        */}
        <dl className="panel mt-8 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Stat label={t("stat.readings")} value={String(readings.length)} />
          <Stat
            label={t("stat.today")}
            value={loggedToday ? `${formatKg(lastReading!.weightKg)} kg` : t("stat.notYet")}
            muted={!loggedToday}
          />
          {/*
            BMI beside waist-to-height, from the **trend** weight (§4.4's rule,
            applied to the number people already know). Waist-to-height is the
            better index and keeps the chart; BMI is here because it is the one
            a doctor will quote.

            **The band is not printed under it.** "Klart över referensintervallet"
            on every page load is a standing judgement, and §3 says this UI has
            no failure state — a verdict that cannot be dismissed, improved away
            in a day, or argued with is the purest form of one. The number is the
            data; where it sits against the reference is interpretation, and
            interpretation goes behind the "?" with everything else.
          */}
          <Stat
            label={t("stat.bmi")}
            value={
              insights.data?.bmi == null
                ? t("stat.notYet")
                : `${formatDecimal(insights.data.bmi, { decimals: 1 })}`
            }
            muted={insights.data?.bmi == null}
            help={t("stat.bmiHelp")}
            explanation={
              <>
                {t("stat.bmiTooltip")}
                {insights.data?.bmi == null
                  ? null
                  : ` ${t("stat.bmiWhere", {
                      band: t(`bmi.${bmiBand(insights.data.bmi)}` as TranslationKey),
                    })}`}
              </>
            }
          />
          <Stat
            label={t("stat.height")}
            value={
              profile?.heightCm == null
                ? t("stat.notYet")
                : `${formatDecimal(profile.heightCm, { decimals: 0 })} cm`
            }
            muted={profile?.heightCm == null}
          />
        </dl>

        {/*
          One of the two ways into the data viewer (D67). Here because this card
          is the reference figures, and that screen is more of them: someone
          reading BMI and height is one step from wanting the series behind
          them. The other entry point is on Dagen, beside the day being logged.
        */}
        <p className="mt-3 text-right">
          <Link
            className="text-micro text-muted underline underline-offset-4 hover:text-ink"
            to="/data"
          >
            {t("data.openLink")}
          </Link>
        </p>
        {/*
          The readings behind the line, at the foot of the page and folded.

          A short list of the most recent few, not a ledger. A mistyped weight
          is visible on the chart as a spike, and the fix has to be reachable
          from the screen the spike is on rather than from a settings page,
          which is why it is here at all rather than in settings.

          Last, because it is the only thing on this page you go looking for
          rather than read. Everything above answers a question on arrival.

          Editing is re-logging: the day holds one canonical reading, so tapping
          a row opens the quick sheet on that day and saving replaces it.
        */}
        {recentReadings.length > 0 ? (
          <div className="mt-8 border-t border-edge pt-2">
            <Disclosure
              label={t("dash.recentReadings")}
              summary={String(readings.length)}
              testId="recent-readings"
            >
            <ul className="mt-2 divide-y divide-edge border-y border-edge">
              {recentReadings.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-baseline justify-between gap-3 py-2.5"
                >
                  <span className="min-w-0 truncate text-note text-ink">
                    {formatLongDay(entry.localDate, LOCALE)}
                  </span>
                  <span className="num shrink-0 text-note text-muted">
                    {formatKg(entry.weightKg)} kg
                  </span>
                  <DeleteButton
                    testId={`delete-weight-${entry.id}`}
                    label={`${formatKg(entry.weightKg)} kg, ${formatLongDay(entry.localDate, LOCALE)}`}
                    onDelete={() => deleteWeight.mutateAsync(entry.id)}
                  />
                </li>
              ))}
            </ul>
            </Disclosure>
          </div>
        ) : null}

      </main>

      {/*
        The full-width fixed "Logga vikt" bar that used to live here is gone.
        It did exactly what the first quick action does, one screenful above,
        and two controls for one action on one screen is the duplication this
        pass set out to remove (D53). It also sat directly over the bottom bar
        on a phone, which is why the first quick action is the one that stayed.
      */}
      <QuickLogSheet
        timezone={timezone}
        open={logOpen}
        onClose={() => {
          setLogOpen(false);
          // Drop the parameter, or navigating back to `/?logga` from the bar
          // would be a no-op the second time.
          if (searchParams.has("logga")) setSearchParams({}, { replace: true });
        }}
        today={today}
        lastWeightKg={lastReading?.weightKg ?? null}
        todayIntakeKcal={todayIntakeKcal}
      />
    </div>
  );
}

/**
 * Sentence case, not all-caps. §5 names all-caps labels as a generic-SaaS tell,
 * and these sit under numbers that are already doing the shouting.
 */
function Stat({
  label,
  value,
  muted = false,
  help,
  explanation,
}: {
  label: string;
  value: string;
  muted?: boolean;
  /** The button's accessible name, when there is an explanation to open. */
  help?: string;
  /**
   * What the figure means, behind the "?".
   *
   * Not printed under the number. A standing sentence of interpretation on
   * every page load is the thing §3 rules out when the interpretation is a
   * judgement, and clutter when it is not.
   */
  explanation?: ReactNode;
}) {
  return (
    <div>
      <dt className="text-note text-muted">
        {label}
        {explanation && help ? <Tooltip label={help}>{explanation}</Tooltip> : null}
      </dt>
      <dd className={`num mt-1 text-metric-sm ${muted ? "text-muted" : "text-ink"}`}>
        {value}
      </dd>
    </div>
  );
}
