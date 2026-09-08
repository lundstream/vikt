import type { MilestoneDto, PotDto } from "shared";
import {
  formatDecimal,
  formatSek,
  METRIC_UNIT,
  metricKind,
  type MilestoneMetric,
} from "shared";
import { formatLongDay } from "../lib/dates.js";
import { LOCALE, plural, t, type TranslationKey } from "../i18n/index.js";

/**
 * The steady header at the top of Framsteg (D51).
 *
 * A **state, not an event**. It renders what is true right now and does it
 * identically on every visit: no animation on load, no confetti, no entrance
 * transition, no "new since last time". D38 buys one deliberate celebration per
 * milestone; a header that also moved on arrival would spend it, and by the
 * eighth visit the motion would mean nothing — which is exactly what the real
 * celebration must not become.
 *
 * It is also the same on a bad week as on a good one. §3 has no failure state,
 * and the mirror of that holds: a header that only lights up when things are
 * going well is visibly dark when they are not.
 *
 * **What it leads with is distance, not money (D60).** It used to show one
 * milestone — `[0]` of the rewards the pot did not yet cover — which was both a
 * bug and the wrong framing. Every unreached milestone is listed now, each with
 * how far it is in its own unit and when the current trend gets there. The pot
 * moved below that: it pays for a reward, it is not the progress.
 */
/** Counted metrics carry an assumption a measured one does not (D79). */
const isCounted = (metric: string) => metricKind(metric) === "counted";

export function ProgressHeader({
  milestones,
  pot,
  streakDays,
}: {
  milestones: MilestoneDto[];
  pot: PotDto;
  streakDays: number;
}) {
  const achieved = milestones.filter((milestone) => milestone.status.state === "achieved");

  /**
   * **Every** unreached milestone, nearest first.
   *
   * The previous version took `[0]` of a filtered list and rendered that one
   * alone, which is why a second milestone looked as though it had never been
   * created. Sorted by how far away it is rather than by insertion order,
   * because "what is next" is a question about distance. Ones with no distance
   * to measure — a metric with no series behind it yet — sort last rather than
   * being dropped, since "nothing to measure from" is itself worth seeing.
   */
  const upcoming = milestones
    .filter((milestone) => milestone.status.state !== "achieved")
    .map((milestone) => ({
      milestone,
      remaining: "remaining" in milestone.status ? milestone.status.remaining : null,
    }))
    .sort((a, b) => {
      if (a.remaining === null) return b.remaining === null ? 0 : 1;
      if (b.remaining === null) return -1;
      return a.remaining - b.remaining;
    });

  /**
   * The nearest reward the pot does not yet cover, for the line at the foot.
   *
   * Already-claimed rewards are excluded: "on the way to new shoes" under a
   * pair bought last week is the app failing to notice something the user
   * definitely has.
   */
  const nextReward = milestones
    .filter(
      (milestone) =>
        milestone.rewardClaimedAt === null &&
        milestone.rewardCostSek !== null &&
        milestone.rewardCostSek > pot.balanceSek,
    )
    .sort((a, b) => a.rewardCostSek! - b.rewardCostSek!)[0];

  return (
    <section aria-label={t("progress.summary")} className="panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-4">
        <div>
          <p className="text-note text-muted">{t("progress.reached")}</p>
          <p className="num mt-1 text-metric text-ink" data-testid="achieved-count">
            {String(achieved.length)}
            <span className="ml-1.5 text-base font-normal text-muted">
              {t("progress.ofCount", { total: milestones.length })}
            </span>
          </p>
        </div>

        <div>
          <p className="text-note text-muted">{t("progress.streak")}</p>
          {/* Gran: a streak counts logging, so it is the logged area. */}
          <p className="num mt-1 text-metric text-logged" data-testid="streak">
            {plural(streakDays, "progress.dayCountOne", "progress.dayCount")}
          </p>
          <p className="mt-1 text-micro text-muted">{t("progress.streakNote")}</p>
        </div>
      </div>

      {/*
        One marker per milestone, filled when reached. A row rather than a count
        alone because the shape of it is the thing worth seeing: four filled out
        of seven says something a "4" does not.

        Not a progress bar. These are discrete and unevenly spaced in effort,
        and a continuous bar would imply the last one is as close as the first.
      */}
      {milestones.length > 0 ? (
        <ul
          className="mt-6 flex flex-wrap gap-2"
          aria-label={t("progress.markers", {
            done: achieved.length,
            total: milestones.length,
          })}
        >
          {milestones.map((milestone) => {
            const done = milestone.status.state === "achieved";
            return (
              <li
                key={milestone.id}
                title={milestone.label}
                data-testid={done ? "marker-done" : "marker-open"}
                /**
                 * Honung (profile, page 8). A reached milestone belongs to the
                 * reward area, not the logging one — the distinction the
                 * profile draws is that streaks are *streck* and milestones are
                 * *belöningar*, and they are two different things that both
                 * happen to feel good.
                 */
                className={`h-2.5 w-8 rounded-full ${done ? "bg-reward" : "bg-edge"}`}
              />
            );
          })}
        </ul>
      ) : null}

      {/* What is left to do, which is what this card is for. */}
      {upcoming.length > 0 ? (
        <ul className="mt-6 space-y-4 border-t border-edge pt-5" data-testid="upcoming">
          {upcoming.map(({ milestone, remaining }) => (
            <UpcomingRow key={milestone.id} milestone={milestone} remaining={remaining} />
          ))}
        </ul>
      ) : milestones.length > 0 ? (
        <p className="mt-6 max-w-prose border-t border-edge pt-5 text-note text-muted">
          {t("progress.allReached")}
        </p>
      ) : null}

      {/*
        The pot, demoted to a footnote of the card it used to headline.

        It is what pays for a reward, not what earns one, and a reward can be
        taken whether or not the balance covers it — the pot is allowed to go
        negative and says so plainly. So nothing here gates or discourages
        claiming: this line reports a balance, and the claim control lives with
        the milestone it belongs to.
      */}
      <p className="mt-6 border-t border-edge pt-4 text-micro text-muted">
        {t("pot.balance")}{" "}
        {/* Honung: the pot is the reward area, and the only figure here in it. */}
        <span className="num text-reward">{formatSek(pot.balanceSek)}</span>
        {nextReward ? (
          <>
            {" · "}
            {t("progress.towardReward", {
              reward: nextReward.rewardText ?? nextReward.label,
            })}{" "}
            <span className="num">
              {t("progress.potOfCost", {
                balance: formatSek(pot.balanceSek),
                cost: formatSek(nextReward.rewardCostSek!),
              })}
            </span>
          </>
        ) : null}
      </p>
    </section>
  );
}

/**
 * One milestone that has not been reached: how far, and when.
 *
 * The distance is in the metric's own unit (D57), so "4,2 kg" and "50 dagar"
 * are both readable without checking which row they belong to. The date comes
 * from `project.ts`'s regression on the smoothed series, the same one the
 * dashboard's goal date uses (§4.3), and renders identically whether it moved
 * closer or further away: §3 has no failure state, and a date slipping is
 * information about a rate rather than a verdict on a person.
 */
function UpcomingRow({
  milestone,
  remaining,
}: {
  milestone: MilestoneDto;
  remaining: number | null;
}) {
  const unit = METRIC_UNIT[milestone.metric as MilestoneMetric] ?? METRIC_UNIT.weight_kg;

  const distance =
    remaining === null
      ? t("progress.noDataYet")
      : t("progress.remainingUnit", {
          remaining: formatDecimal(remaining, { maxDecimals: unit.decimals }),
          unit: unit.suffix === "" ? "" : ` ${unit.suffix}`,
        });

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="min-w-0">
        <span className="block truncate text-note text-ink">{milestone.label}</span>
        <span className="num block text-micro text-muted">
          {t(`metric.${milestone.metric}` as TranslationKey)}{" "}
          {formatDecimal(milestone.targetValue, { maxDecimals: unit.decimals })}
          {unit.suffix === "" ? "" : ` ${unit.suffix}`}
        </span>
      </span>

      <span className="shrink-0 text-right">
        <span className="num block text-metric-sm text-ink">{distance}</span>
        <span className="num block text-micro text-muted">
          {milestone.projectedDate === null
            ? t("progress.noProjection")
            : t("progress.projected", {
                date: formatLongDay(milestone.projectedDate, LOCALE),
              })}
        </span>
        {/*
          What a counted projection assumes, said once and said flatly (D79).

          A streak's date is exact arithmetic, and the only thing that can make
          it wrong is the streak ending. That is worth stating, and it is not
          worth warning about: §3 rules out a failure state, so this names the
          assumption the way a footnote names a method, not the way a notice
          names a risk. Measured metrics get nothing here, because a regression
          already carries its uncertainty in being allowed to say nothing.
        */}
        {milestone.projectedDate !== null && isCounted(milestone.metric) ? (
          <span className="block text-micro text-muted">{t("progress.ifItHolds")}</span>
        ) : null}
      </span>
    </li>
  );
}
