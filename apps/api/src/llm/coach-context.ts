import {
  addDays,
  buildActivityIndex,
  buildLoggedDays,
  computeMeasurementSeries,
  COVERAGE_GATE,
  currentStreak,
  dayMacros,
  windowMacroTotal,
  eachDay,
  formatDecimal,
  MEASUREMENT_SITES,
  smoothedChange,
  type MeasurementSite,
} from "shared";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import { getInsights } from "../services/insights.service.js";
import { getWeightRows, resolveTrend } from "../services/series.service.js";
import { resolveIntake, resolveMacros } from "../services/intake.service.js";
import { getActivities, getDailyLogs, getMeasurements } from "../services/daily.service.js";
import { getFoodEntries } from "../services/food.service.js";
import { getHabitsForDay } from "../services/habit.service.js";
import { getActivePlan } from "../services/plan.service.js";
import { getCorrelations } from "../services/correlation.service.js";
import { listMilestones } from "../repositories/progress.repo.js";
import { meaningFor, type MeaningState } from "./coach-meaning.js";

/**
 * What the coach is allowed to see (D139, D155), §6 phase 8b rule 1.
 *
 * **Aggregates, never rows** — with one exception the rule always implied and
 * never stated: the *names* of what was eaten. A model asked about somebody's
 * eating and given only "2 010 kcal per day" can say nothing about their eating,
 * and answered exactly that, out loud: "jag ser bara sammanställningar". Names
 * with no figures attached are a list of foods, not a food log; the amounts,
 * the times and the macros per item stay here.
 *
 * **Every figure the reply may state comes from here.** That is not only a
 * privacy rule: `coach-guard.ts` uses this same set as the allowlist of numbers
 * a reply may contain, so this file is also the definition of traceable. The
 * invariant is now structural rather than remembered — {@link num} is the only
 * way to put a number into the sheet, and it registers the number as it formats
 * it. A figure that reaches the text has joined the set by construction.
 *
 * **Nothing is recomputed.** Every number is read through the service or the
 * shared calc function that already produces it for a screen. A coach with its
 * own maintenance figure would eventually disagree with the dashboard, in front
 * of somebody looking at both.
 *
 * **An empty domain says so with the data as subject.** Never `0`: a zero is a
 * measurement, and "0 pass" claims somebody sat still for a week when what is
 * true is that nothing was logged. This is the same rule D140's addendum put in
 * the prompt, applied to the sheet the prompt is about.
 *
 * **The size is measured and bounded.** The model variant's context has to hold
 * this block, the turns that travel with it, and the answer.
 */

/**
 * The ceiling for the sheet, in characters, held by a test.
 *
 * Characters rather than tokens because characters can be counted without a
 * tokenizer. Swedish runs about 3.4 characters per token on these models.
 * Raised from 6 000 with the data sheet (D155) and measured rather than
 * guessed; `docs/measurements.md` carries the turn it was measured on.
 */
export const CONTEXT_CHAR_BUDGET = 9000;

/** How many past turns travel with a question. The rest stays in the database. */
export const CONTEXT_TURNS = 6;

/** How many days of trend and intake the coach sees. */
export const CONTEXT_WINDOW_DAYS = 28;

/**
 * The two windows every domain is reported over.
 *
 * Seven is the week somebody is actually living in; twenty-eight is long enough
 * for the trend to mean something and is the window maintenance is estimated
 * over. One window alone invites the wrong reading of the other: a good week
 * inside a bad month, or a month's average hiding the week it is about.
 */
export const WINDOWS = [7, CONTEXT_WINDOW_DAYS] as const;

/** Days of meal names. Seven, because it is the week somebody remembers. */
export const FOOD_NAME_DAYS = 7;

/** Names per day, so one enormous day cannot crowd out the other six. */
const NAMES_PER_DAY = 12;

/**
 * The units a figure in the sheet can carry.
 *
 * Kept apart so "140 g" and "140 kcal" cannot vouch for each other, which is the
 * whole reason the allowlist is per unit rather than a flat set of numbers.
 */
export type FigureUnit =
  | "kcal"
  | "kg"
  | "percent"
  | "kgPerWeek"
  | "grams"
  | "minutes"
  | "steps"
  | "hours"
  | "drinks"
  | "cm"
  | "count"
  /**
   * A dimensionless ratio, which waist-to-height is and a self-rating is not.
   *
   * It was filed under `scale` because neither carries a unit word, and the two
   * then disagreed about precision: the sheet wrote `0,48` and the traceable set
   * recorded `0,5`, so a reply quoting the sheet exactly would have been
   * refused. One unit, one precision (D179).
   */
  | "ratio"
  /**
   * The 1 to 5 self-ratings, which carry no unit word at all.
   *
   * In the set anyway. The guard reads digits **next to a unit**, so "3,4 av 5"
   * was never going to be checked either way; what this keeps true is the
   * invariant that every number written into the sheet is in the traceable set,
   * with no exceptions to remember.
   */
  | "scale";

export type CoachFigures = Record<FigureUnit, number[]>;

/**
 * How many decimals each unit is written with, in one place (D179).
 *
 * **The precision belongs to the unit, not to the call site.** It used to be an
 * argument to `num`, and the weekly rate was passed a 2 at all three of its call
 * sites: the sheet said the weight fell "0,32 kg denna vecka" where §4.1 gives
 * any trend figure one decimal, and the coach quoted it back into the weekly
 * review that appears on Översikt. A number that a call site can choose the
 * shape of is a number that will eventually be the wrong shape somewhere.
 *
 * The traceable set is rounded with this same table, which is the other half:
 * the set has to hold what a reader would read off the page, or a reply quoting
 * the sheet correctly is refused for it.
 */
export const FIGURE_DECIMALS: Record<FigureUnit, number> = {
  kcal: 0,
  kg: 1,
  percent: 0,
  /* A trend figure, and §4.1 gives those one decimal like any other weight. */
  kgPerWeek: 1,
  grams: 0,
  minutes: 0,
  steps: 0,
  hours: 1,
  drinks: 1,
  cm: 1,
  count: 0,
  ratio: 2,
  scale: 1,
};

export const FIGURE_UNITS: FigureUnit[] = [
  "kcal",
  "kg",
  "percent",
  "kgPerWeek",
  "grams",
  "minutes",
  "steps",
  "hours",
  "drinks",
  "cm",
  "count",
  "ratio",
  "scale",
];

export type CoachFacts = {
  /** The block of Swedish the model is given. */
  text: string;
  /** Every number stated in that block: the set a reply may quote, per unit. */
  figures: CoachFigures;
  /** The two limits the post-check enforces in their own right. */
  guardrails: { intakeFloorKcal: number; maxRateKgWeek: number | null };
  chars: number;
};

function emptyFigures(): CoachFigures {
  return {
    kcal: [], kg: [], percent: [], kgPerWeek: [], grams: [], minutes: [],
    steps: [], hours: [], drinks: [], cm: [], count: [], ratio: [], scale: [],
  };
}

/**
 * "1 dag", "2 dagar".
 *
 * Swedish needs exactly two forms and this is the whole rule. It is here rather
 * than imported from the web's `plural` because that one takes translation keys
 * and this sheet is not interface copy; what it shares is the reason for
 * existing, which is that "1 dagar" has shipped in this project before.
 */
function dayWord(count: number): string {
  return count === 1 ? "dag" : "dagar";
}

/** Mean of a list, or null for an empty one. Absent is not zero. */
function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function buildCoachFacts(
  userId: string,
  db: Db,
  env: Env,
  asOf: string,
): Promise<CoachFacts> {
  const from = addDays(asOf, -(CONTEXT_WINDOW_DAYS - 1));
  const foodFrom = addDays(asOf, -(FOOD_NAME_DAYS - 1));

  const [
    insights,
    trend,
    weights,
    intake,
    macroDays,
    dailyLogs,
    activities,
    measurements,
    foodEntries,
    habits,
    milestones,
    plan,
    correlations,
  ] = await Promise.all([
    getInsights(userId, db, asOf, env.SYSTEM_INTAKE_FLOOR_KCAL),
    resolveTrend(userId, db, asOf),
    getWeightRows(userId, db, { from, to: asOf }),
    resolveIntake(userId, db, { from, to: asOf }),
    resolveMacros(userId, db, { from, to: asOf }),
    getDailyLogs(userId, db, { from, to: asOf }),
    getActivities(userId, db, { from, to: asOf }),
    getMeasurements(userId, db, {}),
    getFoodEntries(userId, db, { from: foodFrom, to: asOf }),
    getHabitsForDay(userId, db, asOf),
    listMilestones(userId, db),
    getActivePlan(userId, db),
    getCorrelations(userId, db, asOf),
  ]);

  const figures = emptyFigures();
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);

  /**
   * The only way a number gets into the sheet.
   *
   * Formats it with the shared Swedish formatter at the precision its **unit**
   * carries, so the coach's "2 350" is the app's "2 350" and a weight is one
   * decimal wherever it appears, and records it in the traceable set for that
   * unit in the same breath. Two things that used to be done in two places and could therefore
   * be done in one of them: the previous sheet stated several figures with bare
   * interpolation and several more with a formatter, and pushed them onto the
   * allowlist by hand, one `push` per `say`.
   */
  const num = (value: number, unit: FigureUnit): string => {
    figures[unit].push(value);
    return formatDecimal(value, { decimals: FIGURE_DECIMALS[unit] });
  };

  /** The window lengths themselves are figures the reply will quote back. */
  for (const window of WINDOWS) figures.count.push(window);

  const days = [...eachDay(from, asOf)];
  const windowDays = (length: number) => days.slice(-length);

  say(`I dag är ${asOf}. Allt nedan är räknat över 7 och ${CONTEXT_WINDOW_DAYS} dagar.`);

  /* ------------------------------------------------------ vikt och trend */

  say("");
  say("VIKT OCH TREND");

  const trendNow = trend.at(-1)?.trend ?? null;
  const windowStart = trend.find((point) => point.localDate >= from)?.trend ?? null;

  if (trendNow !== null) {
    say(`Trendvikt nu: ${num(trendNow, "kg")} kg.`);

    if (windowStart !== null && Math.abs(trendNow - windowStart) >= 0.05) {
      const change = trendNow - windowStart;
      const weekly = Math.abs((change / CONTEXT_WINDOW_DAYS) * 7);
      say(
        `Trendvikten har ${change < 0 ? "gått ner" : "gått upp"} ` +
          `${num(Math.abs(change), "kg")} kg på ${num(CONTEXT_WINDOW_DAYS, "count")} dagar, ` +
          `vilket är ${num(weekly, "kgPerWeek")} kg i veckan.`,
      );
    }
  } else {
    say("Ingen trendvikt än: det finns för få vägningar.");
  }

  if (weights.length > 0) {
    say(
      `Vägningar: ${num(weights.length, "count")} på ${num(CONTEXT_WINDOW_DAYS, "count")} dagar.`,
    );
  } else {
    say(`Inga vägningar är loggade de senaste ${num(CONTEXT_WINDOW_DAYS, "count")} dagarna.`);
  }

  /**
   * What the domain means, from the closed set (D171).
   *
   * The state is read off what this section just said, never recomputed: the
   * line and the figures above it have to agree, and choosing the line from the
   * same values is the only way to be sure of that.
   */
  say(
    meaningFor(
      "weight",
      trendNow === null
        ? "none"
        : weights.length < 3
          ? "thin"
          : windowStart === null || Math.abs(trendNow - windowStart) < 0.05
            ? "steady"
            : trendNow < windowStart
              ? "low"
              : "high",
    ),
  );

  /* ------------------------------------------------- underhåll och intag */

  say("");
  say("INTAG MOT UNDERHÅLL");

  const { maintenance } = insights;
  if (maintenance.tdee !== null) {
    say(
      `Underhållsnivå: ${num(maintenance.tdee, "kcal")} kcal per dag. ` +
        `Källa: ${maintenance.source === "adaptive" ? "adaptiv, räknad ur din egen data" : "formel"}. ` +
        `Tillförlitlighet ${num(maintenance.confidence * 100, "percent")} procent, ` +
        `täckning ${num(maintenance.coverage * 100, "percent")} procent av fönstret.`,
    );
    if (maintenance.estimateShare > 0) {
      say(
        `${num(maintenance.estimateShare * 100, "percent")} procent av den loggade energin ` +
          "är uppskattad snarare än mätt.",
      );
    }
  } else {
    say("Ingen underhållsnivå än. Den kräver fler dagar med både vikt och mat.");
  }

  /** Set from the 7-day window below, so the line matches the week's figures. */
  let intakeState: MeaningState = "none";

  for (const window of WINDOWS) {
    const inWindow = windowDays(window);
    const logged = inWindow
      .map((day) => intake.get(day))
      .filter((value): value is number => value !== undefined && value > 0);

    if (logged.length === 0) {
      say(`${window} dagar: inget intag är loggat.`);
      continue;
    }

    const average = mean(logged)!;
    const coverage = (logged.length / inWindow.length) * 100;
    const against =
      maintenance.tdee === null
        ? ""
        : ` Mot underhåll: ${num(Math.abs(average - maintenance.tdee), "kcal")} kcal ` +
          `${average < maintenance.tdee ? "under" : "över"} per loggad dag.`;

    say(
      `${num(window, "count")} dagar: i snitt ${num(average, "kcal")} kcal per loggad dag, ` +
        `${num(logged.length, "count")} av ${num(inWindow.length, "count")} dagar loggade ` +
        `(${num(coverage, "percent")} procent täckning).${against}`,
    );

    if (window === 7) {
      /**
       * Below §4.2's coverage gate the mean is thin, and with no measured
       * maintenance there is nothing to be above or below: the same uncertainty
       * said about the other missing half.
       */
      intakeState =
        logged.length < Math.ceil(COVERAGE_GATE * inWindow.length) || maintenance.tdee === null
          ? "thin"
          : Math.abs(average - maintenance.tdee) < 100
            ? "steady"
            : average < maintenance.tdee
              ? "low"
              : "high";
    }
  }

  say(meaningFor("intake", intakeState));

  /* --------------------------------------------------------------- plan */

  say("");
  say("PLAN OCH SPÄRRAR");

  if (plan) {
    say(
      `Plan: ${
        plan.goalWeightKg === null
          ? "inget målvikt satt"
          : `mål ${num(plan.goalWeightKg, "kg")} kg`
      }, dagligt mål ${num(plan.targetIntakeKcal, "kcal")} kcal, ` +
        `golv ${num(plan.intakeFloorKcal, "kcal")} kcal.`,
    );
    if (plan.targetRateKgWeek !== null) {
      say(`Planerad takt: ${num(Math.abs(plan.targetRateKgWeek), "kgPerWeek")} kg i veckan.`);
    }
  } else {
    say("Ingen aktiv plan.");
  }

  /**
   * The two limits, stated to the model **and** handed to the post-check.
   *
   * Telling it is not enough on its own, which is the argument for checking the
   * reply at all (rule 2); a model told what the limits are still breaks them
   * far less often than one left to infer them.
   */
  const floor = plan?.intakeFloorKcal ?? insights.systemFloorKcal;
  const maxRate = trendNow !== null ? trendNow * 0.01 : null;
  say(
    `Spärrar appen räknar med: intaget föreslås aldrig under ${num(floor, "kcal")} kcal per dag` +
      (maxRate === null
        ? "."
        : `, och takten aldrig snabbare än ${num(maxRate, "kgPerWeek")} kg i veckan, ` +
          `vilket är ${num(1, "percent")} procent av kroppsvikten.`),
  );

  /* ------------------------------------------------------------- makron */

  say("");
  say("MAKRON MOT DINA EGNA MÅL");
  say(
    "Ett snitt som står som minst bygger på mat där uppgiften saknas för en del av energin, " +
      "så det verkliga snittet är minst så högt.",
  );

  const macroNames = {
    protein: "Protein",
    carbs: "Kolhydrater",
    fat: "Fett",
    fiber: "Fiber",
  } as const;

  if (insights.macros) {
    for (const key of ["protein", "carbs", "fat", "fiber"] as const) {
      const macro = insights.macros[key];
      const target = macro.targetG;
      const source = macro.overridden ? "ditt eget" : "NNR";

      /**
       * Fibre is reported only where it is tracked at all (D155).
       *
       * A database entry without a fibre figure is not a day with no fibre in
       * it, and most of them have none: saying "0 g fibre" about somebody who
       * eats bread would be the sheet inventing a fact out of a gap in a food
       * table. So: is there any day at all with fibre on it.
       */
      const perWindow: string[] = [];
      let tracked = false;
      /** Fewer than four logged days in the week is a mean worth doubting. */
      let macroThin = false;

      /**
       * The same rule as the dashboard (D55, addendum 2026-09-15): every logged
       * day contributes its known grams, and the snitt says "minst" as soon as
       * one of them was under the gate. Until then this dropped partial days,
       * which on thin food data left the coach with "no average" for a week of
       * real logging.
       */
      for (const window of WINDOWS) {
        const dayTotals = windowDays(window).map((day) => dayMacros(macroDays.get(day) ?? []));
        const total = windowMacroTotal(dayTotals, key);
        if (total.meanG === null) continue;
        tracked = true;
        if (window === 7 && total.days < 4) macroThin = true;

        // Under the target is only known for a complete day. A partial day
        // under it may not be, so it is not counted either way.
        const completeDays = dayTotals.filter((day) => day.kcal !== null && day[key].complete);
        const under = completeDays.filter((day) => (day[key].grams ?? 0) < target).length;

        let sentence =
          `${num(window, "count")} dagar: snitt ${total.complete ? "" : "minst "}` +
          `${num(total.meanG, "grams")} g från ${num(total.days, "count")} loggade ${dayWord(total.days)}`;
        if (!total.complete) {
          sentence +=
            `, varav ${num(total.partialDays, "count")} med ofullständiga uppgifter ` +
            `(${num(total.coverage * 100, "percent")} procent av energin har uppgift om ` +
            `${macroNames[key].toLowerCase()})`;
        }
        if (completeDays.length > 0) {
          sentence += total.complete
            ? `, ${num(under, "count")} av dem under målet`
            : `, ${num(under, "count")} av de fullständiga dagarna under målet`;
        }
        perWindow.push(sentence);
      }

      if (!tracked) {
        say(
          `${macroNames[key]}: mål ${num(target, "grams")} g per dag (${source}). ` +
            `Ingen loggad mat har uppgift om ${macroNames[key].toLowerCase()}, så det finns inget snitt.`,
        );
        if (key === "protein" || key === "fiber") say(meaningFor(key, "none"));
        continue;
      }

      say(
        `${macroNames[key]}: mål ${num(target, "grams")} g per dag (${source}). ` +
          perWindow.join(". ") +
          ".",
      );

      /**
       * Protein and fibre only (D171). Each answers a question somebody
       * actually asks; carbohydrate and fat have no general claim this app is
       * willing to make, and inventing one to fill the table would be the
       * opposite of a reviewed set.
       */
      if (key === "protein" || key === "fiber") {
        say(meaningFor(key, macroThin ? "thin" : "low"));
      }
    }
  } else {
    say("Inga makromål: de härleds ur en aktiv plan, och det finns ingen.");
  }

  /* ------------------------------------------------------------ alkohol */

  say("");
  say("ALKOHOL");

  const alcoholByDay = new Map(
    dailyLogs
      .filter((row) => row.alcoholUnits !== null)
      .map((row) => [row.localDate, row.alcoholUnits!] as const),
  );

  let alcoholState: MeaningState = "none";

  if (alcoholByDay.size === 0) {
    say("Alkohol är inte ifylld på någon dag i fönstret.");
  } else {
    for (const window of WINDOWS) {
      const inWindow = windowDays(window)
        .map((day) => alcoholByDay.get(day))
        .filter((value): value is number => value !== undefined);

      if (inWindow.length === 0) {
        say(`Alkohol ${num(window, "count")} dagar: inte ifylld på någon av dagarna.`);
        continue;
      }

      const total = inWindow.reduce((sum, value) => sum + value, 0);
      const sober = inWindow.filter((value) => value === 0).length;
      if (window === 7) {
        alcoholState =
          inWindow.length < 4 ? "thin" : total === 0 ? "low" : total >= 7 ? "high" : "steady";
      }
      say(
        `Alkohol ${num(window, "count")} dagar: ${num(total, "drinks")} standardglas ` +
          `totalt, ifyllt på ${num(inWindow.length, "count")} ${dayWord(inWindow.length)}, varav ` +
          `${num(sober, "count")} ${sober === 1 ? "nykter" : "nyktra"}.`,
      );
    }
  }

  say(meaningFor("alcohol", alcoholState));

  /* ------------------------------------------------------------ rörelse */

  say("");
  say("RÖRELSE OCH STEG");

  const activityIndex = buildActivityIndex(
    activities.map((row) => ({
      localDate: row.localDate,
      durationMin: row.durationMin,
      kcalEstimate: row.kcalEstimate,
    })),
  );

  let activityState: MeaningState = "none";

  if (activities.length === 0) {
    say(`Ingen rörelse är loggad de senaste ${num(CONTEXT_WINDOW_DAYS, "count")} dagarna.`);
  } else {
    for (const window of WINDOWS) {
      const inWindow = new Set(windowDays(window));
      const sessions = activities.filter((row) => inWindow.has(row.localDate));
      const minutes = [...activityIndex]
        .filter(([day]) => inWindow.has(day))
        .reduce((sum, [, day]) => sum + day.minutes, 0);

      if (sessions.length === 0) {
        say(`Rörelse ${num(window, "count")} dagar: ingen rörelse är loggad.`);
        continue;
      }

      if (window === 7) activityState = sessions.length < 2 ? "thin" : "steady";
      say(
        `Rörelse ${num(window, "count")} dagar: ${num(sessions.length, "count")} pass, ` +
          `${num(minutes, "minutes")} minuter totalt.`,
      );
    }
  }

  say(meaningFor("activity", activityState));

  const stepsByDay = dailyLogs.filter((row) => row.steps !== null);
  let stepsState: MeaningState = "none";

  if (stepsByDay.length === 0) {
    say("Steg är inte ifyllda på någon dag i fönstret.");
  } else {
    for (const window of WINDOWS) {
      const inWindow = new Set(windowDays(window));
      const values = stepsByDay
        .filter((row) => inWindow.has(row.localDate))
        .map((row) => row.steps!);
      const average = mean(values);

      if (average === null) {
        say(`Steg ${num(window, "count")} dagar: inte ifyllda på någon av dagarna.`);
        continue;
      }
      if (window === 7) stepsState = values.length < 4 ? "thin" : "steady";
      say(
        `Steg ${num(window, "count")} dagar: i snitt ${num(average, "steps")} per dag ` +
          `från ${num(values.length, "count")} ${dayWord(values.length)}.`,
      );
    }
  }

  say(meaningFor("steps", stepsState));

  /* --------------------------------------------- sömn, energi och humör */

  say("");
  say("SÖMN, ENERGI OCH HUMÖR");

  const scales = [
    { key: "sleepHours", label: "Sömn", unit: "hours" as FigureUnit, suffix: " timmar" },
    { key: "energy", label: "Energi", unit: "scale" as FigureUnit, suffix: " av 5" },
    { key: "mood", label: "Humör", unit: "scale" as FigureUnit, suffix: " av 5" },
  ] as const;

  let sleepState: MeaningState = "none";

  for (const scale of scales) {
    const rows = dailyLogs.filter((row) => row[scale.key] !== null);
    if (rows.length === 0) {
      say(`${scale.label} är inte ifyllt på någon dag i fönstret.`);
      continue;
    }

    const parts: string[] = [];
    for (const window of WINDOWS) {
      const inWindow = new Set(windowDays(window));
      const values = rows.filter((row) => inWindow.has(row.localDate)).map((row) => row[scale.key]!);
      const average = mean(values);
      if (average === null) continue;
      if (scale.key === "sleepHours" && window === 7) {
        sleepState = values.length < 4 ? "thin" : average < 7 ? "low" : "steady";
      }
      parts.push(
        `${num(window, "count")} dagar: snitt ${num(average, scale.unit)}` +
          `${scale.suffix} från ${num(values.length, "count")} ${dayWord(values.length)}`,
      );
    }

    say(
      parts.length === 0
        ? `${scale.label} är inte ifyllt i fönstret.`
        : `${scale.label}, ${parts.join(". ")}.`,
    );
  }

  say(meaningFor("sleep", sleepState));

  /* ------------------------------------------------------------- vanor */

  say("");
  say("VANOR");

  if (habits.length === 0) {
    say("Inga vanor är upplagda.");
  } else {
    for (const habit of habits) {
      say(
        `${habit.name}: ${habit.checked ? "avbockad i dag" : "inte avbockad i dag"}` +
          (habit.streak.days > 0
            ? `, ${num(habit.streak.days, "count")} ${dayWord(habit.streak.days)} i rad`
            : "") +
          ".",
      );
    }
  }

  const loggedDays = buildLoggedDays({
    weight: weights.map((row) => ({ localDate: row.localDate })),
    daily: dailyLogs.map((row) => ({ localDate: row.localDate })),
    food: days.filter((day) => (intake.get(day) ?? 0) > 0).map((day) => ({ localDate: day })),
  });
  const streak = currentStreak(loggedDays, asOf);
  say(
    streak.days === 0
      ? "Loggningsstreck: ingen dag i rad är loggad just nu."
      : `Loggningsstreck: ${num(streak.days, "count")} ${dayWord(streak.days)} i rad.`,
  );
  say(meaningFor("habits", habits.length === 0 ? "none" : "steady"));

  /* --------------------------------------------------------------- mått */

  say("");
  say("MÅTT");

  const readings = measurements.map((row) => ({
    localDate: row.localDate,
    waist: row.waistCm,
    chest: row.chestCm,
    neck: row.neckCm,
    hips: row.hipsCm,
    thigh: row.thighCm,
    arm: row.armCm,
  }));

  const siteNames: Record<MeasurementSite, string> = {
    waist: "Midja",
    chest: "Bröst",
    neck: "Hals",
    hips: "Höft",
    thigh: "Lår",
    arm: "Arm",
  };

  const measured: string[] = [];
  for (const site of MEASUREMENT_SITES) {
    const series = computeMeasurementSeries(readings, site, { to: asOf });
    const last = series.at(-1);
    if (!last) continue;

    /**
     * The smoothed change, never a difference of two raw readings: two tape
     * measurements 28 days apart differ by their real change plus up to 2 cm of
     * tape error, and `calc/measurements.ts` exists to keep that out of a
     * sentence somebody will read as a result.
     */
    const change = smoothedChange(series, CONTEXT_WINDOW_DAYS);
    measured.push(
      `${siteNames[site]}: ${num(last.trend, "cm")} cm` +
        (change === null
          ? ""
          : `, ${change.deltaCm < 0 ? "ner" : "upp"} ${num(Math.abs(change.deltaCm), "cm")} cm ` +
            `på ${num(CONTEXT_WINDOW_DAYS, "count")} dagar`),
    );
  }

  if (measured.length === 0) {
    say("Inga mått är loggade.");
  } else {
    for (const line of measured) say(`${line}.`);
  }

  say(
    meaningFor(
      "measurements",
      measured.length === 0 ? "none" : readings.length < 3 ? "thin" : "steady",
    ),
  );

  /* ---------------------------------------------------------- milstolpar */

  const open = milestones.filter((row) => row.achievedAt === null).slice(0, 5);
  if (open.length > 0) {
    say("");
    say("MILSTOLPAR");
    /**
     * A milestone target carries a unit, and printing it without one produced
     * "50 dagar nykter vid 50,0" with the 50 filed as kilograms. The metric is
     * on the row; the only reason it was not used is that every milestone
     * anybody had made until now happened to be a weight.
     */
    const metrics: Record<string, { unit: FigureUnit; suffix: string }> = {
      weight_kg: { unit: "kg", suffix: " kg" },
      waist_cm: { unit: "cm", suffix: " cm" },
      chest_cm: { unit: "cm", suffix: " cm" },
      /* A ratio, not a self-rating: they used to share `scale` and disagree
         about precision, which the traceable set could not represent. */
      whtr: { unit: "ratio", suffix: "" },
      log_streak_days: { unit: "count", suffix: " dagar" },
      sober_days: { unit: "count", suffix: " dagar" },
    };

    for (const row of open) {
      const shape = metrics[row.metric] ?? { unit: "scale" as FigureUnit, suffix: "" };
      say(
        `${row.label}: mål ${num(Number(row.targetValue), shape.unit)}` +
          `${shape.suffix}.`,
      );
    }
  }

  /* ------------------------------------------------------------ samband */

  say("");
  say("SAMBAND");

  /**
   * What Samband has actually computed, which is **no coefficient at all**
   * (D34, and the schema says so in as many words).
   *
   * The screen pairs three series and reports how many days line up; it
   * deliberately reports no r, no fitted line and no verdict, because every
   * pair is one person's self-report over a few weeks with obvious third
   * causes. So what the sheet can honestly carry is which pairs the app plots
   * together and whether each has enough days to plot at all. The rule in
   * COACH_RULES is written against exactly that: two series may be put side by
   * side through a pair named here, and never with a cause between them.
   */
  const paneNames: Record<string, string> = {
    sleep_energy: "sömn och energi",
    activity_sweat: "rörelse och svettighet",
    intake_trend_change: "intag och trendförändring",
  };

  for (const pane of correlations.panes) {
    const name = paneNames[pane.pane] ?? pane.pane;
    if (pane.sampleSize === 0) {
      say(
        pane.unit === "week"
          ? `${name}: det finns ingen hel vecka där båda är ifyllda.`
          : `${name}: det finns ingen dag där båda är ifyllda.`,
      );
      continue;
    }

    // Weeks for intake against trend change, days for the others (D166).
    const unit = pane.unit === "week" ? "hela veckor" : "dagar";
    say(
      // `enough` and `needed` are the service's own answers, not recomputed here.
      pane.enough
        ? `${name}: ${num(pane.sampleSize, "count")} ${unit} där båda finns. Appen ritar dem ` +
          "mot varandra under Samband, men räknar inget samband och påstår ingen orsak."
        : `${name}: bara ${num(pane.sampleSize, "count")} ${unit} där båda finns, och ` +
          `${num(pane.needed, "count")} behövs innan appen ritar något.`,
    );
  }

  /* ------------------------------------------------------------ maten */

  say("");
  say(`MAT DE SENASTE ${FOOD_NAME_DAYS} DAGARNA, BARA NAMN`);

  const byDay = new Map<string, string[]>();
  for (const entry of foodEntries) {
    const list = byDay.get(entry.localDate) ?? [];
    if (!list.includes(entry.name)) list.push(entry.name);
    byDay.set(entry.localDate, list);
  }

  const foodDays = [...eachDay(foodFrom, asOf)];
  if (byDay.size === 0) {
    say(`Ingen mat är loggad de senaste ${num(FOOD_NAME_DAYS, "count")} dagarna.`);
  } else {
    for (const day of foodDays) {
      const names = byDay.get(day);
      say(
        names === undefined || names.length === 0
          ? `${day}: ingen mat loggad.`
          : `${day}: ${names.slice(0, NAMES_PER_DAY).join(", ")}.`,
      );
    }
    say("Inga mängder, inga kalorier och inga makron per maträtt finns här, bara namnen.");
  }

  const text = lines.join("\n");

  /**
   * Deduplicated per unit, at the precision the sheet stated them.
   *
   * Rounding here rather than at the call site so the set holds what a reader
   * would read off the page: the sheet says "2 350 kcal", so 2 350 is what a
   * reply may quote. **From the same table `num` writes with**, which is what
   * keeps the two halves from disagreeing: they were two lists of numbers and
   * `scale` said 1 in one and 2 in the other.
   */
  const dedupe = (values: number[], unit: FigureUnit): number[] => [
    ...new Set(values.map((value) => Number(value.toFixed(FIGURE_DECIMALS[unit])))),
  ];

  return {
    text,
    figures: Object.fromEntries(
      FIGURE_UNITS.map((unit) => [unit, dedupe(figures[unit], unit)]),
    ) as CoachFigures,
    guardrails: { intakeFloorKcal: floor, maxRateKgWeek: maxRate },
    chars: text.length,
  };
}
