import { useEffect, useState } from "react";
import type { InsightsResponse, MacroLineDto, MacroTargetsDto } from "shared";
import { formatDecimal, formatKcal } from "shared";
import { Tooltip } from "./Tooltip.js";
import { t, type TranslationKey } from "../i18n/index.js";

/**
 * Today, in one card: what has been eaten, what is left, and the macros.
 *
 * One idea, generous space around it (§5). The eaten figure is the card's
 * subject and is centred and large; everything else steps down from it.
 *
 * Two things here are decisions rather than layout.
 *
 * **Coverage (D55).** Crowdsourced food data frequently lacks individual
 * macros. Summing only the entries that have them produces a total that looks
 * like an answer and is silently low — absent-is-not-zero at its quietest,
 * because unlike a missing day it does not look like an absence. So every macro
 * carries the fraction of the day's energy it was computed from, and at or
 * below 90% the row says *at least* rather than stating a total.
 *
 * **The week, not the day.** NNR's values refer to average intake over at least
 * a week, so the bar is filled against the seven-day mean and the day's own
 * figure sits beside it as an amount. A daily bar going red on an ordinary
 * Tuesday would assert something the source does not say, in the app's
 * most-visited card.
 */
export function DayCard({
  insights,
  onLogFood,
}: {
  insights: InsightsResponse;
  onLogFood: () => void;
}) {
  const { todayIntakeKcal, targetIntakeKcal, todayRemainingKcal, macros } = insights;
  const nothingLogged = todayIntakeKcal === null;

  return (
    <section aria-label={t("day.section")} className="panel">
      <p className="text-center text-note text-muted">{t("day.eaten")}</p>

      {/*
        A day with nothing logged says so. Rendering 0 kcal would state that
        nothing was eaten, which is a claim about the day rather than about the
        log, and it is almost never true (§3).
      */}
      {nothingLogged ? (
        <>
          <p className="mt-1 text-center text-figure-sm text-muted">{t("stat.notYet")}</p>
          <p className="mx-auto mt-2 max-w-prose text-center text-note text-muted">
            {t("day.nothingLogged")}
          </p>
          <div className="mt-4 flex justify-center">
            <button type="button" className="btn-secondary" onClick={onLogFood}>
              {t("day.logFirst")}
            </button>
          </div>
        </>
      ) : (
        <>
          {/*
            Blåbär, because this figure *is* the nutrition area (profile,
            page 8). Maintenance, the target and the projections beside it stay
            Snö and Sten: they are summaries of several areas, not one of them.
          */}
          <p
            className="num mt-1 text-center text-figure-sm text-nutrition"
            data-testid="day-eaten"
          >
            {formatKcal(todayIntakeKcal)}
            <span className="ml-2 align-baseline text-metric-sm font-normal text-muted">
              kcal
            </span>
          </p>

          <p className="num mt-2 text-center text-note text-muted">
            {targetIntakeKcal === null
              ? t("day.noTarget")
              : todayRemainingKcal === null
                ? ""
                : todayRemainingKcal >= 0
                  ? t("day.remaining", {
                      amount: formatKcal(todayRemainingKcal),
                      target: formatKcal(targetIntakeKcal),
                    })
                  : t("day.over", {
                      amount: formatKcal(-todayRemainingKcal),
                      target: formatKcal(targetIntakeKcal),
                    })}
          </p>
        </>
      )}

      {macros ? <Macros macros={macros} /> : null}
    </section>
  );
}

const MACRO_KEYS = ["protein", "carbs", "fat", "fiber"] as const;

/**
 * Which window the bars are drawn against.
 *
 * Both views show the same bars against the same targets. What differs is what
 * the comparison *claims*, and that has to be visible rather than implied:
 *
 * - **week** is the verdict. NNR's values are averages over at least a week, so
 *   this is the only view entitled to say a target is met or missed.
 * - **today** is an indication. Someone who eats much the same food most days
 *   can read a single day usefully, and daily feedback is what a person can act
 *   on this evening. It is framed as where the day sits, never as a pass or a
 *   fail: no red, no warning state, no "missat" anywhere near it, because §3
 *   has no failure state and a single day is not evidence of one either way.
 */
type MacroView = "today" | "week";

function Macros({ macros }: { macros: MacroTargetsDto }) {
  /**
   * Coverage is per macro, because a food can carry protein and not fibre. In
   * practice a source usually carries all four or none, so all four rows end up
   * with the same figure — and four identical lines saying "66% of today's food
   * has data" is the card explaining itself four times.
   *
   * So: one line when they agree, and only then. The moment two macros differ
   * the rows say it themselves, because at that point the difference *is* the
   * information.
   */
  const partials = MACRO_KEYS.map((key) => macros[key]).filter(
    (line) => line.todayG !== null && !line.todayComplete,
  );
  const sharedCoverage =
    partials.length === MACRO_KEYS.length &&
    new Set(partials.map((line) => Math.round(line.todayCoverage * 100))).size === 1
      ? Math.round(partials[0]!.todayCoverage * 100)
      : null;

  /**
   * The week is the default when there is a week to show, because it is the
   * view that can actually answer the question. Today otherwise, so the card is
   * never sitting on an empty set of bars with a full one a tap away.
   */
  const hasWeek = MACRO_KEYS.some((key) => macros[key].weeklyMeanG !== null);
  const [view, setView] = useState<MacroView>(hasWeek ? "week" : "today");

  /**
   * Seeded from the data, so it has to follow the data: a first meal logged on
   * an empty week must not leave the card stuck on a view that was chosen
   * before the answer existed.
   */
  useEffect(() => {
    setView(hasWeek ? "week" : "today");
  }, [hasWeek]);

  return (
    <div className="mt-7 border-t border-edge pt-5">
      {/*
        Everything that explains the numbers lives behind the "?": where the
        targets come from, that NNR's values are weekly averages, that they are
        set for groups rather than for a person, and why protein may be raised.

        The card keeps its data and one line of context. The text is not
        shortened — a vaguer sentence would be worse than a longer one, because
        the point of stating the group-level caveat is that it is precise — it
        is one tap away instead of always on screen. Five paragraphs standing
        permanently over four bars was the card explaining itself more loudly
        than it reported anything.
      */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-note text-muted">
          {t("macro.heading")}
          <Tooltip label={t("macro.help")}>
            <span className="block">{t("macro.tooltip")}</span>
            <span className="mt-2 block">{t("macro.groupLevel")}</span>
            {macros.proteinBasis === "per_kg" ? (
              <span className="mt-2 block">{t("macro.proteinRaised")}</span>
            ) : null}
          </Tooltip>
        </h3>

        <ViewToggle value={view} onChange={setView} hasWeek={hasWeek} />
      </div>

      <ul className="mt-4 space-y-4">
        {MACRO_KEYS.map((key) => (
          <MacroRow
            key={key}
            name={key}
            line={macros[key]}
            view={view}
            showCoverage={sharedCoverage === null}
          />
        ))}
      </ul>

      {/*
        One line saying what this view is comparing against. On the weekly view
        it is the recommendation being met or not; on today it says explicitly
        that the recommendation is a weekly average, so the bars beside it
        cannot be read as a verdict.
      */}
      <p className="mt-4 max-w-prose text-micro text-muted">
        {view === "week" ? t("macro.weekIsTheVerdict") : t("macro.todayIsAnIndication")}
      </p>

      {/*
        Said once, under the group, rather than four times under four identical
        bars. Every row has the same answer when the coverage agrees, and
        repeating it turned the emptiest state on the screen into the wordiest.
      */}
      {view === "today" && sharedCoverage !== null ? (
        <p className="mt-2 max-w-prose text-micro text-muted">
          {t("macro.partial", { percent: sharedCoverage })}
        </p>
      ) : null}

      {view === "week" && !hasWeek ? (
        <p className="mt-2 max-w-prose text-micro text-muted">{t("macro.needMoreDays")}</p>
      ) : null}
    </div>
  );
}

/**
 * Two segments, not a switch.
 *
 * A switch has an on state and an off state, and neither of these is off. The
 * labels are both visible so the choice is legible before it is made, which is
 * the same reason the quick actions are labelled (D53).
 */
function ViewToggle({
  value,
  onChange,
  hasWeek,
}: {
  value: MacroView;
  onChange: (next: MacroView) => void;
  hasWeek: boolean;
}) {
  const option = (key: MacroView, label: string, disabled = false) => (
    <button
      type="button"
      key={key}
      data-testid={`macro-view-${key}`}
      aria-pressed={value === key}
      disabled={disabled}
      onClick={() => onChange(key)}
      className={[
        "min-h-11 rounded-md px-3 text-micro transition-colors sm:min-h-0 sm:py-1.5",
        value === key ? "bg-edge text-ink" : "text-muted hover:text-ink",
        disabled ? "opacity-40" : "",
      ].join(" ")}
    >
      {label}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={t("macro.viewLabel")}
      className="flex shrink-0 items-center gap-1"
    >
      {option("today", t("macro.viewToday"))}
      {/* Disabled rather than hidden: a control that appears on the fourth day
          is a control nobody knows exists. */}
      {option("week", t("macro.viewWeek"), !hasWeek)}
    </div>
  );
}

function MacroRow({
  name,
  line,
  view,
  showCoverage,
}: {
  name: (typeof MACRO_KEYS)[number];
  line: MacroLineDto;
  view: MacroView;
  /** False when the group says it once above, for all four at the same figure. */
  showCoverage: boolean;
}) {
  const label = t(`macro.${name}` as TranslationKey);

  /** The amount this view is about, and null when this view has nothing yet. */
  const amount = view === "week" ? line.weeklyMeanG : line.todayG;
  const filled = amount === null ? null : amount / line.targetG;

  /**
   * Below the coverage gate a total is a floor rather than a figure (D55), so
   * the day says "minst". The weekly mean is built only from days that cleared
   * the gate, so it never needs the hedge.
   */
  const partialToday = view === "today" && line.todayG !== null && !line.todayComplete;

  const heading =
    amount === null
      ? t("stat.notYet")
      : partialToday
        ? t("macro.atLeastOfTarget", { amount: grams(amount), target: grams(line.targetG) })
        : t("macro.gramsOfTarget", { amount: grams(amount), target: grams(line.targetG) });

  const footnote =
    view === "week"
      ? line.weeklyMeanG === null
        ? null
        : t("macro.overDays", { days: line.weeklyDays })
      : showCoverage && partialToday
        ? t("macro.partial", { percent: Math.round(line.todayCoverage * 100) })
        : null;

  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-note text-ink">
          {label}
          {line.overridden ? (
            <span className="ml-2 text-micro text-muted">{t("macro.yourOwn")}</span>
          ) : null}
        </span>

        <span className="num shrink-0 text-note text-muted">{heading}</span>
      </div>

      {/*
        Never coloured as a failure, in either view: §3 has no failure state,
        and being under a reference value on a Wednesday is not one. Over the
        target simply fills the bar.
      */}
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-edge"
        role="img"
        aria-label={
          amount === null
            ? t("macro.noneYet", { name: label })
            : view === "week"
              ? t("macro.weekly", {
                  name: label,
                  amount: grams(amount),
                  target: grams(line.targetG),
                  days: line.weeklyDays,
                })
              : t("macro.daily", {
                  name: label,
                  amount: grams(amount),
                  target: grams(line.targetG),
                })
        }
      >
        {filled === null ? null : (
          <span
            /**
             * Blåbär, and the same Blåbär for all four macros (profile,
             * page 3). Four hues would make protein a different *kind* of
             * thing from fat, which it is not: they are four readings of one
             * area, and the label beside each bar is what tells them apart.
             */
            className="block h-full rounded-full bg-nutrition"
            style={{ width: `${Math.min(100, Math.max(0, filled * 100))}%` }}
          />
        )}
      </div>

      {footnote === null ? null : (
        <p className="num mt-1 text-micro text-muted">{footnote}</p>
      )}
    </li>
  );
}

const grams = (value: number) => formatDecimal(value, { decimals: 0 });
