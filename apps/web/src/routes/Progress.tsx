import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MilestoneDto, PotDto } from "shared";
import {
  checkMilestoneTarget,
  createMilestoneSchema,
  createSavingsRuleSchema,
  formatDecimal,
  formatSek,
  METRIC_UNIT,
  type MilestoneMetric,
} from "shared";
import { Celebration } from "../components/Celebration.js";
import { Disclosure } from "../components/Disclosure.js";
import { Sheet } from "../components/Sheet.js";
import { ProgressHeader } from "../components/ProgressHeader.js";
import { SavingsRules } from "../components/SavingsRules.js";
import { MilestoneFields, band } from "../components/MilestoneFields.js";
import { DeleteButton } from "../components/DeleteButton.js";
import { OfflineNotice } from "../components/SyncIndicator.js";
import { Field, fieldAria, fieldErrorsFrom, type FieldErrors } from "../components/Field.js";
import {
  useAcknowledgeCelebration,
  useClaimReward,
  useCreateMilestone,
  useCreateSavingsRule,
  useDeleteMilestone,
  useProgress,
  useUpdateMilestone,
} from "../lib/progress.js";
import { useMe } from "../lib/session.js";
import { formatLongDay, todayLocalDate } from "../lib/dates.js";
import { readNumber } from "../lib/form-number.js";
import { alpha, usePrefersReducedMotion, useTokens } from "../lib/tokens.js";
import { ApiError } from "../lib/api.js";
import { LOCALE, plural, t, type TranslationKey } from "../i18n/index.js";

/**
 * Milestones, rewards and the pot.
 *
 * Two rules from §3 shape this screen more than anything visual.
 *
 * **There is no failure state.** A projected date that slips renders exactly
 * like one that does not: same weight, same colour, no arrow, no warning. A
 * date moving is information about a rate, not a verdict on a person, and
 * marking it red would turn the most useful number here into something people
 * avoid looking at.
 *
 * **Absent is not zero.** A milestone with no projectable series says it has no
 * date rather than showing today's.
 */
export function Progress() {
  const me = useMe();
  const timezone = me.data?.profile.timezone ?? "Europe/Stockholm";
  const today = todayLocalDate(timezone);

  const progress = useProgress(today);
  const acknowledge = useAcknowledgeCelebration();
  const claim = useClaimReward(today);

  const celebrate = progress.data?.celebrate ?? null;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">{t("progress.title")}</h1>
          <p className="text-note text-muted">{t("progress.subtitle")}</p>
        </div>
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("nav.dashboard")}
        </Link>
      </header>

      {progress.isError ? <OfflineNotice what="progress" /> : null}

      {progress.isPending ? (
        <p role="status" className="text-note text-muted">
          {t("app.loading")}
        </p>
      ) : null}

      {progress.data ? (
        <>
          {/*
            A steady state, not a repeated celebration (D51). What is true right
            now: milestones reached, the streak, the pot against the nearest
            reward. No animation on load and no "new since last time" — D38
            already buys one deliberate moment per milestone, and a header that
            also moved on arrival would spend it.
          */}
          <ProgressHeader
            milestones={progress.data.milestones}
            pot={progress.data.pot}
            streakDays={progress.data.streak.days}
          />

          {/*
            The pot next, then the streak, then the two lists folded away
            (D126).

            The order is what somebody opens this screen to find out, in
            descending order of how often the answer has changed since last
            time. The header card answers "how far" — D60 put every unreached
            milestone in it, nearest first, which is why there is no separate
            distance block here: pulling that list out of the card would only
            put a border between two halves of one answer. The pot answers "can
            I afford the reward yet", and it moves daily. The lists answer
            "what did I set up", which changes when somebody changes it, and
            that is the definition of reference material (§5).
          */}
          <div className="mt-10">
            <PotPanel pot={progress.data.pot} />
          </div>

          <StreakPanel sober={progress.data.sober} />

          <MilestonesSection
            milestones={progress.data.milestones}
            onClaim={(id) => void claim.mutateAsync(id)}
            claiming={claim.isPending}
          />

          <SavingsSection pot={progress.data.pot} today={today} />
        </>
      ) : null}

      {celebrate ? (
        <Celebration
          milestone={celebrate}
          onDismiss={() => void acknowledge.mutateAsync(celebrate.id)}
        />
      ) : null}
    </main>
  );
}

/* ------------------------------------------------------------------- pot */

/**
 * The pot, and the line that makes it visibly climb.
 *
 * An area rather than a plain line, because this is the one chart in the app
 * that is about accumulation rather than change, and it deliberately does not
 * borrow the lingonberry that belongs to the trend line alone (§5).
 */
function PotPanel({ pot }: { pot: PotDto }) {
  const tokens = useTokens();
  const reducedMotion = usePrefersReducedMotion();

  const negative = pot.balanceSek < 0;

  return (
    <section>
      <p className="text-note text-muted">{t("pot.balance")}</p>
      {/*
        `metric`, not `figure-sm`.

        "Utan alkohol" and "I potten" are peer figures a few hundred pixels
        apart on the same screen, and they were set two steps of the scale
        apart, which read as a claim that one of them mattered more. The scale
        exists so that a size means something; two peers get one size.
      */}
      <p
        className="num text-metric text-ink"
        data-testid="pot-balance"
      >
        {formatSek(pot.balanceSek)}
      </p>

      {/*
        A negative balance is stated plainly rather than clamped or coloured as
        an error: claiming a reward early is a choice the user made, and the pot
        catching up is the normal next thing that happens.
      */}
      {negative ? (
        <p className="mt-1 max-w-prose text-note text-muted">{t("pot.negative")}</p>
      ) : null}

      {pot.weeklyRateSek > 0 ? (
        <p className="num mt-1 text-note text-muted">
          {t("pot.perWeek", { amount: formatSek(pot.weeklyRateSek) })}
        </p>
      ) : null}

      {pot.series.length > 1 ? (
        <div className="mt-4 h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            {/* `accessibilityLayer` off for the same reason as the trend chart:
                it puts `tabIndex={0}` and `role="application"` on the SVG, and a
                container nobody can operate should not take a focus ring. */}
            <AreaChart
              data={pot.series}
              margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
              accessibilityLayer={false}
              role="img"
              aria-label={t("pot.chartLabel", { amount: formatSek(pot.balanceSek) })}
            >
              <CartesianGrid stroke={tokens.edge} vertical={false} />
              <XAxis
                dataKey="localDate"
                stroke={tokens.muted}
                tick={{ fill: tokens.muted, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tickFormatter={(value: string) =>
                  new Intl.DateTimeFormat(LOCALE, {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  }).format(new Date(`${value}T00:00:00Z`))
                }
              />
              <YAxis
                width={56}
                stroke={tokens.muted}
                tick={{ fill: tokens.muted, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => formatDecimal(value, { decimals: 0 })}
              />
              <Tooltip
                cursor={{ stroke: tokens.edge }}
                isAnimationActive={false}
                content={<PotTooltip />}
              />
              <Area
                dataKey="balanceSek"
                type="monotone"
                stroke={tokens.reward}
                strokeWidth={2}
                fill={alpha(tokens.reward, 0.18)}
                isAnimationActive={!reducedMotion}
                animationDuration={500}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="mt-3 max-w-prose text-note text-muted">
          {/*
            Two different absences: nothing set up at all, versus a rule that
            started today and has one point to its name. The second is not a
            prompt to add a rule, which would be wrong advice.
          */}
          {pot.rules.length === 0 ? t("pot.noRulesYet") : t("pot.oneDayYet")}
        </p>
      )}

    </section>
  );
}

function PotTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: { localDate: string; balanceSek: number } }[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border border-edge bg-paper px-3 py-2 text-micro shadow-sm">
      <p className="text-muted">{formatLongDay(point.localDate, LOCALE)}</p>
      <p className="num mt-1 text-ink">{formatSek(point.balanceSek)}</p>
    </div>
  );
}

/* --------------------------------------------------------- folded lists */

/**
 * The milestones somebody has set up, folded away, with the button that adds
 * one beside the fold (D126).
 *
 * Two changes, and they are the same change. The list was open on arrival and
 * an empty create form sat underneath it, so a screen about *how far there is
 * to go* opened on a form for typing in a new target. Both are now what §5
 * calls reference material: one tap from the fold, nothing on screen until
 * asked for.
 *
 * The add button stays outside the disclosure on purpose. Adding a milestone is
 * not a thing you do to the list, so it must not cost a fold first, and a
 * button that is only reachable through a disclosure is the failure the
 * component's own doc warns about.
 */
function MilestonesSection({
  milestones,
  onClaim,
  claiming,
}: {
  milestones: MilestoneDto[];
  onClaim: (id: string) => void;
  claiming: boolean;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="mt-10 border-t border-edge pt-6">
      <Disclosure
        label={t("progress.milestones")}
        summary={String(milestones.length)}
        testId="milestones"
      >
        {milestones.length === 0 ? (
          <p className="mt-2 max-w-prose text-note text-muted">{t("progress.noMilestones")}</p>
        ) : (
          <ul className="mt-4 divide-y divide-edge border-y border-edge">
            {milestones.map((milestone) => (
              <MilestoneRow
                key={milestone.id}
                milestone={milestone}
                onClaim={() => onClaim(milestone.id)}
                claiming={claiming}
              />
            ))}
          </ul>
        )}
      </Disclosure>

      <button
        type="button"
        data-testid="open-milestone-form"
        className="btn-secondary mt-4"
        onClick={() => setAdding(true)}
      >
        {t("progress.addMilestone")}
      </button>

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={t("progress.addMilestone")}
        testId="milestone-sheet"
      >
        <MilestoneForm onDone={() => setAdding(false)} />
      </Sheet>
    </section>
  );
}

/**
 * The savings rules, on the same pattern.
 *
 * They used to hang off the bottom of the pot panel, which put a list nobody
 * edits from month to month directly under the chart that changes daily. The
 * retroactive note travels with them: a rule is the record the pot accrues
 * from (D54), and that is worth reading beside the rules rather than beside
 * the balance.
 */
function SavingsSection({ pot, today }: { pot: PotDto; today: string }) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="mt-10 border-t border-edge pt-6">
      <Disclosure
        label={t("pot.rules")}
        summary={String(pot.rules.length)}
        testId="savings-rules"
      >
        {pot.rules.length === 0 ? (
          <p className="mt-2 max-w-prose text-note text-muted">{t("pot.noRulesYet")}</p>
        ) : (
          <>
            <p className="mt-2 max-w-prose text-micro text-muted">{t("pot.retroactiveNote")}</p>
            <SavingsRules rules={pot.rules} today={today} />
          </>
        )}
      </Disclosure>

      <button
        type="button"
        data-testid="open-rule-form"
        className="btn-secondary mt-4"
        onClick={() => setAdding(true)}
      >
        {t("pot.addRule")}
      </button>

      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title={t("pot.addRule")}
        testId="rule-sheet"
      >
        <SavingsRuleForm onDone={() => setAdding(false)} />
      </Sheet>
    </section>
  );
}

/* ------------------------------------------------------------ milestones */

/**
 * Reads the target the way its metric is measured.
 *
 * Weight to one decimal, a ratio to two, days as whole numbers. The row used to
 * print `maxDecimals: 2` for all six, so a 100-day sober target read "100" and
 * a 0.5 ratio read "0,5" by luck rather than by rule.
 */
function formatTarget(metric: MilestoneDto["metric"], value: number): string {
  const unit = METRIC_UNIT[metric as MilestoneMetric] ?? METRIC_UNIT.weight_kg;
  const amount = formatDecimal(value, { maxDecimals: unit.decimals });
  return unit.suffix === "" ? amount : `${amount} ${unit.suffix}`;
}

function MilestoneRow({
  milestone,
  onClaim,
  claiming,
}: {
  milestone: MilestoneDto;
  onClaim: () => void;
  claiming: boolean;
}) {
  const achieved = milestone.achievedAt !== null;
  const [editing, setEditing] = useState(false);

  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        {/* Honung: a reached milestone belongs to the reward area, not the
            logged one (profile, page 3, "nådd milstolpe"). */}
        <span className={achieved ? "text-note text-reward" : "text-note text-ink"}>
          {milestone.label}
        </span>
        <span className="num text-micro text-muted">
          {t(`metric.${milestone.metric}` as TranslationKey)}{" "}
          {formatTarget(milestone.metric, milestone.targetValue)}
        </span>

        {/*
          Edit and delete, per §3: every user-created row gets both, on the
          screen that shows the row. The API has had them since phase 5; the
          controls are what was missing, which is the same gap in a different
          place, because an endpoint nothing calls is not a feature.
        */}
        <button
          type="button"
          data-testid={`edit-milestone-${milestone.id}`}
          className="min-h-11 shrink-0 px-1 text-micro text-muted underline underline-offset-4 hover:text-ink"
          onClick={() => setEditing((wasEditing) => !wasEditing)}
        >
          {editing ? t("common.cancel") : t("common.edit")}
        </button>
      </div>

      <p className="mt-1 text-micro text-muted">
        <StatusLine milestone={milestone} />
      </p>

      {/*
        The projected date. Rendered identically whether it moved closer or
        further away: §3 has no failure state, and a slipping date is
        information about a rate, not a verdict.
      */}
      {!achieved && milestone.projectedDate ? (
        <p className="num mt-1 text-micro text-muted">
          {t("progress.projected", {
            date: formatLongDay(milestone.projectedDate, LOCALE),
          })}
        </p>
      ) : null}

      {milestone.rewardText ? (
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <span className="text-micro text-muted">
            {milestone.rewardText}
            {milestone.rewardCostSek !== null
              ? ` (${formatSek(milestone.rewardCostSek)})`
              : ""}
          </span>

          {achieved && milestone.rewardClaimedAt === null ? (
            <button
              type="button"
              data-testid={`claim-${milestone.id}`}
              className="px-2 py-1.5 text-micro text-ink underline underline-offset-4"
              onClick={onClaim}
              disabled={claiming}
            >
              {t("progress.claim")}
            </button>
          ) : milestone.rewardClaimedAt !== null ? (
            <span className="text-micro text-muted">{t("progress.claimed")}</span>
          ) : milestone.rewardAffordable === false &&
            milestone.daysUntilAffordable !== null ? (
            <span className="num text-micro text-muted">
              {t("progress.potIn", { days: milestone.daysUntilAffordable })}
            </span>
          ) : milestone.rewardAffordable ? (
            <span className="text-micro text-muted">{t("progress.potCovers")}</span>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <MilestoneEditor milestone={milestone} onDone={() => setEditing(false)} />
      ) : null}
    </li>
  );
}

/**
 * Editing a milestone in place.
 *
 * Unlike a savings rule, this needs no consequence preview: `achieved_at` is
 * stamped once and never recomputed (§4, D38), so changing a target does
 * not un-reach anything, and nothing else is derived from the row. Deleting is
 * the two-tap confirm every other log row uses.
 */
function MilestoneEditor({
  milestone,
  onDone,
}: {
  milestone: MilestoneDto;
  onDone: () => void;
}) {
  const update = useUpdateMilestone();
  const remove = useDeleteMilestone();

  const unit = METRIC_UNIT[milestone.metric as MilestoneMetric] ?? METRIC_UNIT.weight_kg;
  const [fields, setFields] = useState({
    label: milestone.label,
    metric: milestone.metric as string,
    targetValue: formatDecimal(milestone.targetValue, { maxDecimals: unit.decimals }),
    rewardText: milestone.rewardText ?? "",
    rewardCostSek:
      milestone.rewardCostSek === null
        ? ""
        : formatDecimal(milestone.rewardCostSek, { maxDecimals: 2 }),
  });
  const [errors, setErrors] = useState<FieldErrors>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    const parsed = parseMilestoneFields(fields);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }

    try {
      await update.mutateAsync({ id: milestone.id, input: parsed.value });
      onDone();
    } catch (error) {
      setErrors({ form: error instanceof ApiError ? error.message : t("auth.unreachable") });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="mt-3">
      <MilestoneFields
        idPrefix={`me-${milestone.id}`}
        {...fields}
        errors={errors}
        onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}
      >
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            data-testid={`save-milestone-${milestone.id}`}
            className="btn-secondary"
            disabled={update.isPending || remove.isPending}
          >
            {t("progress.saveMilestone")}
          </button>
          <DeleteButton
            testId={`delete-milestone-${milestone.id}`}
            label={milestone.label}
            onDelete={() => remove.mutateAsync(milestone.id)}
          />
        </div>
      </MilestoneFields>
    </form>
  );
}

/**
 * Form strings to a validated payload, or per-field messages.
 *
 * Shared by the create form and the editor so the two cannot disagree about
 * what a valid milestone is. The band check runs here as well as on the server
 * (§3 puts the guardrails server-side); this half is what makes the message
 * appear under the field instead of at the top of the form.
 */
function parseMilestoneFields(fields: {
  label: string;
  metric: string;
  targetValue: string;
  rewardText: string;
  rewardCostSek: string;
}):
  | { ok: true; value: ReturnType<typeof createMilestoneSchema.parse> }
  | { ok: false; errors: FieldErrors } {
  const target = readNumber(fields.targetValue, { required: true });
  if (!target.ok) return { ok: false, errors: { targetValue: target.message } };

  const inBand = checkMilestoneTarget(fields.metric as MilestoneMetric, target.value!);
  if (!inBand.ok) {
    return {
      ok: false,
      errors: {
        targetValue: t("progress.targetOutOfRange", {
          min: band(inBand.unit.min),
          max: band(inBand.unit.max),
          // Waist-to-height has no unit, and " 1,5 ." is a worse sentence than
          // one that simply ends. The space belongs to the suffix, not to the
          // template, which is how the server phrases it too.
          unit: inBand.unit.suffix === "" ? "" : ` ${inBand.unit.suffix}`,
        }),
      },
    };
  }

  const cost = readNumber(fields.rewardCostSek);
  if (!cost.ok) return { ok: false, errors: { rewardCostSek: cost.message } };

  const parsed = createMilestoneSchema.safeParse({
    label: fields.label.trim(),
    metric: fields.metric,
    targetValue: target.value,
    rewardText: fields.rewardText.trim() === "" ? null : fields.rewardText.trim(),
    rewardCostSek: cost.value,
  });

  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: fieldErrorsFrom(parsed.error.issues) };
}

function StatusLine({ milestone }: { milestone: MilestoneDto }) {
  const { status } = milestone;

  if (status.state === "achieved") {
    return <>{t("progress.achievedOn", { date: formatLongDay(status.achievedAt.slice(0, 10), LOCALE) })}</>;
  }
  if (status.state === "raw_reached") {
    return <>{t("progress.rawReached")}</>;
  }
  if (status.state === "close") {
    return (
      <>
        {t("progress.close", {
          remaining: formatDecimal(status.remaining, { maxDecimals: 2 }),
        })}
      </>
    );
  }
  if (status.remaining === null) return <>{t("progress.noDataYet")}</>;
  return (
    <>
      {t("progress.remaining", {
        remaining: formatDecimal(status.remaining, { maxDecimals: 2 }),
      })}
    </>
  );
}

function MilestoneForm({ onDone }: { onDone: () => void }) {
  const create = useCreateMilestone();
  const [fields, setFields] = useState({
    label: "",
    metric: "weight_kg",
    targetValue: "",
    rewardText: "",
    rewardCostSek: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    const parsed = parseMilestoneFields(fields);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }

    try {
      await create.mutateAsync(parsed.value);
      // Closing on success is the acknowledgement: the milestone appears in the
      // list behind the sheet, and its count goes up by one. Clearing the
      // fields first anyway, because the sheet is not unmounted and a failed
      // second attempt should not reopen onto the first one's values.
      setFields((current) => ({
        ...current,
        label: "",
        targetValue: "",
        rewardText: "",
        rewardCostSek: "",
      }));
      onDone();
    } catch (error) {
      setErrors({ form: error instanceof ApiError ? error.message : t("auth.unreachable") });
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <MilestoneFields
        idPrefix="ms"
        {...fields}
        errors={errors}
        onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}
      >
        <button
          type="submit"
          data-testid="add-milestone"
          className="btn mt-4"
          disabled={create.isPending}
        >
          {t("progress.addMilestone")}
        </button>
      </MilestoneFields>
    </form>
  );
}

function StreakPanel({
  sober,
}: {
  sober: {
    days: number | null;
    basis: string;
    rule: string;
    countingFrom: string | null;
  };
}) {
  return (
    <section className="mt-10 border-t border-edge pt-6">
      {/*
        The streak moved into the header, note and all. Two figures reading
        "78 dagar" on one screen, both at metric size, was the clearest
        duplication the design pass turned up.
      */}
      <div>
        <p className="text-note text-muted">{t("progress.sober")}</p>
        {/*
          Gran when there is a count, Sten when there is not (profile, page 8).
          Nyktra dagar are a streak, so they take the logged colour; "inte än"
          is an absence of information and takes no accent at all.
        */}
        <p
          className={`num text-metric ${sober.days === null ? "text-uncertain" : "text-logged"}`}
          data-testid="sober"
        >
          {sober.days === null
            ? t("stat.notYet")
            : plural(sober.days, "progress.dayCountOne", "progress.dayCount")}
        </p>
        {/*
          Which rule produced the number, always (D35). The strict reading stops
          at an unlogged day, and saying so is the difference between a count
          someone can trust and one that quietly rewards not logging.
        */}
        <p className="mt-1 text-micro text-muted">
          {sober.basis === "no_data"
            ? t("progress.soberNoData")
            : sober.basis === "seeded"
              ? t("progress.soberSeeded")
              : sober.rule === "assumeSober"
                ? t("progress.soberAssume")
                : sober.basis === "gap"
                  ? t("progress.soberGap")
                  : t("progress.soberStrict")}
        </p>
      </div>
    </section>
  );
}

function SavingsRuleForm({ onDone }: { onDone: () => void }) {
  const create = useCreateSavingsRule();
  const me = useMe();
  const today = todayLocalDate(me.data?.profile.timezone ?? "Europe/Stockholm");

  const [label, setLabel] = useState("");
  const [amountSek, setAmountSek] = useState("");
  const [cadence, setCadence] = useState("weekday");
  const [errors, setErrors] = useState<FieldErrors>({});

  const cadences = useMemo(
    () => ["every_day", "weekday", "weekend_day", "per_event"] as const,
    [],
  );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    const amount = readNumber(amountSek, { required: true });
    if (!amount.ok) {
      setErrors({ amountSek: amount.message });
      return;
    }

    const parsed = createSavingsRuleSchema.safeParse({
      label: label.trim(),
      amountSek: amount.value,
      cadence,
      startDate: today,
    });
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    try {
      await create.mutateAsync(parsed.data);
      setLabel("");
      setAmountSek("");
      onDone();
    } catch (error) {
      setErrors({ form: error instanceof ApiError ? error.message : t("auth.unreachable") });
    }
  }

  return (
    <>
      {/* What a rule does, before the fields that make one. */}
      <p className="max-w-prose text-note text-muted">{t("pot.addRuleNote")}</p>

      <form onSubmit={onSubmit} noValidate className="mt-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field id="sr-label" label={t("pot.ruleLabel")} error={errors.label}>
            <input
              id="sr-label"
              className="field"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              {...fieldAria("sr-label", errors.label)}
            />
          </Field>
          <Field id="sr-amount" label={t("pot.amount")} error={errors.amountSek}>
            <input
              id="sr-amount"
              className="field num"
              type="text"
              inputMode="decimal"
              value={amountSek}
              onChange={(event) => setAmountSek(event.target.value)}
              {...fieldAria("sr-amount", errors.amountSek)}
            />
          </Field>
          <Field id="sr-cadence" label={t("pot.cadence")}>
            <select
              id="sr-cadence"
              className="select"
              value={cadence}
              onChange={(event) => setCadence(event.target.value)}
            >
              {cadences.map((name) => (
                <option key={name} value={name}>
                  {t(`cadence.${name}` as TranslationKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {errors.form ? (
          <p role="alert" className="mt-2 text-note text-ink">
            {errors.form}
          </p>
        ) : null}

        <button type="submit" data-testid="add-rule" className="btn mt-4">
          {t("pot.addRule")}
        </button>
      </form>
    </>
  );
}
