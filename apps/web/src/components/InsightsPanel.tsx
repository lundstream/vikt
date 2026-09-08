import { Link } from "react-router-dom";
import type { InsightsResponse, Maintenance, ProjectionDto } from "shared";
import { formatKcal, formatKg, MIN_WINDOW_DAYS } from "shared";
import { formatLongDay } from "../lib/dates.js";
import { Tooltip } from "./Tooltip.js";
import { LOCALE, t, type TranslationKey } from "../i18n/index.js";

/**
 * Maintenance, the daily target, and the two projections.
 *
 * Three rules from the constitution shape this component:
 *
 *  - the source and the confidence are **always shown**, never hidden behind a
 *    tidy-looking number (§4.2, D3);
 *  - the two projections sit **side by side and are never blended** (§4.3);
 *  - **there is no failure state** (§3). Before there is enough history this
 *    says what it is waiting for and how long, rather than showing zeroes, a
 *    spinner, or an estimate nobody should act on.
 *
 * Every number arrives pre-computed from `packages/shared/src/calc/` via
 * `GET /api/insights`. Nothing is recalculated here.
 */
export function InsightsPanel({ insights }: { insights: InsightsResponse }) {
  const { maintenance, projections, targetIntakeKcal, goalWeightKg } = insights;

  /*
   * No divider across the top. The panel this renders into already has a
   * border and a background of its own, so the rule was a second edge four
   * pixels inside the first: a line drawn to separate this card from itself.
   */
  return (
    <section aria-label={t("insights.section")}>
      <div className="grid gap-8 sm:grid-cols-2">
        <MaintenanceFigure maintenance={maintenance} readingCount={insights.readingCount} />

        <div>
          <h3 className="text-note text-muted">
            {t("insights.dailyTarget")}
            <Tooltip label={t("insights.dailyTargetHelp")}>
              {t("insights.dailyTargetTooltip")}
            </Tooltip>
          </h3>
          {targetIntakeKcal === null ? (
            <p className="mt-1 text-note text-muted">{t("insights.noPlan")}</p>
          ) : (
            <p className="num mt-1 text-metric text-ink">
              {formatKcal(targetIntakeKcal)}
              <span className="ml-1.5 text-base font-normal text-muted">kcal</span>
            </p>
          )}

          {maintenance.tdee !== null && targetIntakeKcal !== null ? (
            <p className="num mt-2 text-micro text-muted">
              {formatDeficit(maintenance.tdee - targetIntakeKcal)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-note text-muted">
          {t("insights.reaching", {
            goal:
              goalWeightKg === null
                ? t("insights.yourGoal")
                : `${formatKg(goalWeightKg)} kg`,
          })}
          {/*
            The two footnotes that used to sit under the dates live here now,
            each still attached to the projection it describes. Kept word for
            word: "om du äter ditt mål varje dag" is the entire difference
            between the two numbers, and a vaguer version would be worse than
            the clutter it replaced.
          */}
          <Tooltip label={t("insights.projectionHelp")}>
            <span className="block">{t("insights.projectionTooltip")}</span>
            <span className="mt-2 block">
              <span className="text-ink">{t("insights.onPlan")}:</span>{" "}
              {t("insights.onPlanHint")}
            </span>
            <span className="mt-1 block">
              <span className="text-ink">{t("insights.atCurrentPace")}:</span>{" "}
              {t("insights.atCurrentPaceHint")}
            </span>
          </Tooltip>
        </h3>

        {goalWeightKg === null ? (
          <p className="mt-2 max-w-prose text-note text-muted">{t("insights.setGoal")}</p>
        ) : (
          <div className="mt-3 grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <ProjectionFigure
              label={t("insights.onPlan")}
              projection={projections.onPlan}
              absent={
                maintenance.tdee === null
                  ? t("insights.needsMaintenance")
                  : t("insights.noDeficit")
              }
            />
            <ProjectionFigure
              label={t("insights.atCurrentPace")}
              projection={projections.atCurrentPace}
              absent={t("insights.noMovement")}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function MaintenanceFigure({
  maintenance,
  readingCount,
}: {
  maintenance: Maintenance;
  readingCount: number;
}) {
  return (
    <div>
      <h3 className="text-note text-muted">
        {t("insights.maintenance")}
        <Tooltip label={t("insights.maintenanceHelp")}>
          <span className="block">{t("insights.maintenanceTooltip")}</span>
          <span className="mt-2 block">{t("insights.confidenceTooltip")}</span>
        </Tooltip>
      </h3>

      {maintenance.source === "none" ? (
        <MaintenanceAbsent maintenance={maintenance} readingCount={readingCount} />
      ) : (
        <>
          <p className="num mt-1 text-metric text-ink">
            {formatKcal(maintenance.tdee!)}
            <span className="ml-1.5 text-base font-normal text-muted">kcal</span>
          </p>

          {/*
            A formula estimate is not an early point on the adaptive ramp. It
            will be *replaced*, not grown into, so showing it as one filled
            segment of four reads as progress that is not happening. It gets
            prose instead, and the bar is reserved for figures the bar's scale
            actually describes.
          */}
          {/*
            One line of context, and that is all.

            The adaptive case keeps its window and coverage, because those say
            how much the figure is worth and a reader has to see them to weigh
            it (§4.2, D3). The confidence bar stays for the same reason. What
            went behind the "?" is the *explanation* of where the number comes
            from, which is a thing you read once.

            The formula case keeps the one sentence that says it is an estimate
            and what makes it stop being one.
          */}
          {maintenance.source === "adaptive" ? (
            <>
              <p className="num mt-2 text-micro text-muted">
                {t("insights.fromYourData", {
                  days: maintenance.windowDays,
                  percent: Math.round(maintenance.coverage * 100),
                })}
              </p>
              {/*
                What is in force when the window contains estimates (D82).

                An estimated day counts toward coverage, because excluding it
                would drop the whole adaptive figure for anyone who eats out.
                What it costs is confidence, and a bar that had quietly dropped
                with no explanation would be the app knowing something it did
                not say.
              */}
              {maintenance.estimateShare > 0 ? (
                <p className="num mt-1 max-w-prose text-micro text-muted">
                  {t("insights.estimateShare", {
                    percent: Math.round(maintenance.estimateShare * 100),
                  })}
                </p>
              ) : null}
              <ConfidenceBar confidence={maintenance.confidence} />
            </>
          ) : (
            <p className="mt-2 max-w-prose text-micro text-muted">
              {t("insights.fromFormula")}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The pre-data state, written deliberately.
 *
 * It has one job: make the next few days of logging feel worth doing. So it
 * says what is missing, how long is left, and nothing that could be read as
 * having done badly.
 */
function MaintenanceAbsent({
  maintenance,
  readingCount,
}: {
  maintenance: Maintenance;
  readingCount: number;
}) {
  const needsProfile = maintenance.missing.length > 0;

  return (
    <div className="mt-1">
      <p className="text-metric-sm text-muted">
        {t("insights.notYet")}
      </p>

      <p className="mt-2 max-w-prose text-note text-muted">
        {readingCount === 0
          ? t("insights.startLogging")
          : maintenance.blockedBy === "history"
            ? t("insights.daysLeft", {
                days: maintenance.daysUntilAdaptive ?? 0,
                dayWord:
                  maintenance.daysUntilAdaptive === 1
                    ? t("insights.dayOne")
                    : t("insights.dayMany"),
              })
            : t("insights.coverageShort", {
                percent: Math.round(maintenance.coverage * 100),
                days: maintenance.windowDays,
              })}
      </p>

      {needsProfile ? (
        <p className="mt-3 max-w-prose text-note text-muted">
          {t("insights.couldEstimate", { fields: describeMissing(maintenance.missing) })}{" "}
          <Link className="text-ink underline underline-offset-4" to="/profile">
            {maintenance.missing.length === 1
              ? t("insights.addOne")
              : t("insights.addMany")}
          </Link>{" "}
          {t("insights.orSkip")}
        </p>
      ) : null}

      {maintenance.blockedBy === "history" ? (
        <p className="num mt-3 text-micro text-muted">
          {t("insights.ofDays", {
            have: maintenance.windowDays,
            need: MIN_WINDOW_DAYS,
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Confidence, shown rather than hidden (§4.2). Not a percentage: the number is
 * an ordering, not a calibrated probability (D19), and dressing it up as
 * "73% confident" would claim a precision it does not have.
 */
function ConfidenceBar({ confidence }: { confidence: number }) {
  const label =
    confidence >= 0.75
      ? t("confidence.strong")
      : confidence >= 0.45
        ? t("confidence.fair")
        : confidence >= 0.2
          ? t("confidence.early")
          : t("confidence.rough");

  return (
    <div className="mt-3">
      <div
        className="flex h-1 w-28 gap-0.5"
        role="img"
        aria-label={t("insights.confidence", { level: label })}
      >
        {[0, 1, 2, 3].map((step) => (
          <span
            key={step}
            className={`h-full flex-1 rounded-full ${
              /*
                No accent (profile, page 8). Maintenance, the target and the
                projections are *summaries* rather than areas — they are
                computed from several — so they stay Snö and Sten. Gran here
                would have said "logged", which the confidence in a derived
                figure is not.
              */
              confidence > step * 0.25 ? "bg-ink" : "bg-edge"
            }`}
          />
        ))}
      </div>
      <p className="mt-1.5 text-micro text-muted">
        {t("insights.confidenceLabel", { level: label })}
      </p>
    </div>
  );
}

/**
 * One projection.
 *
 * The footnote under each — "om du äter ditt mål varje dag", "ur de senaste 28
 * dagarnas trendlinje" — moved into the "?" on the heading above, which already
 * explains that the two are never blended (§4.3). Two dates with two
 * explanatory lines under them is four lines of text around two numbers, and
 * the difference between the two dates is what the reader is here for.
 */
function ProjectionFigure({
  label,
  projection,
  absent,
}: {
  label: string;
  projection: ProjectionDto | null;
  absent: string;
}) {
  return (
    <div>
      <p className="text-micro text-muted">{label}</p>

      {projection === null ? (
        <p className="mt-1 text-note text-muted">{absent}</p>
      ) : projection.alreadyThere ? (
        <p className="mt-1 text-lg text-ink">{t("insights.alreadyThere")}</p>
      ) : (
        <>
          <p className="num mt-1 text-lg text-ink">
            {formatLongDay(projection.targetDate, LOCALE)}
          </p>
          <p className="num mt-0.5 text-micro text-muted">
            {t("insights.daysCount", { days: projection.daysToGoal })}
          </p>
        </>
      )}

    </div>
  );
}

function formatDeficit(deficit: number): string {
  const rounded = Math.round(deficit);
  if (rounded <= 0) return t("insights.atOrAbove");
  return t("insights.belowMaintenance", { amount: formatKcal(rounded) });
}

function describeMissing(missing: Maintenance["missing"]): string {
  const parts = missing.map((field) => t(`field.${field}` as TranslationKey));
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} och ${parts.at(-1)}`;
}
