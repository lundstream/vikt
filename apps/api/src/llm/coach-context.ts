import {
  addDays,
  buildActivityIndex,
  buildLoggedDays,
  computeMeasurementSeries,
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
   * The 1 to 5 self-ratings, which carry no unit word at all.
   *
   * In the set anyway. The guard reads digits **next to a unit**, so "3,4 av 5"
   * was never going to be checked either way; what this keeps true is the
   * invariant that every number written into the sheet is in the traceable set,
   * with no exceptions to remember.
   */
  | "scale";

export type CoachFigures = Record<FigureUnit, number[]>;

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
    steps: [], hours: [], drinks: [], cm: [], count: [], scale: [],
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
   * Formats it with the shared Swedish formatter, so the coach's "2 350" is the
   * app's "2 350", and records it in the traceable set for its unit in the same
   * breath. Two things that used to be done in two places and could therefore
   * be done in one of them: the previous sheet stated several figures with bare
   * interpolation and several more with a formatter, and pushed them onto the
   * allowlist by hand, one `push` per `say`.
   */
  const num = (value: number, unit: FigureUnit, decimals = 0): string => {
    figures[unit].push(value);
    return formatDecimal(value, { decimals });
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
    say(`Trendvikt nu: ${num(trendNow, "kg", 1)} kg.`);

    if (windowStart !== null && Math.abs(trendNow - windowStart) >= 0.05) {
      const change = trendNow - windowStart;
      const weekly = Math.abs((change / CONTEXT_WINDOW_DAYS) * 7);
      say(
        `Trendvikten har ${change < 0 ? "gått ner" : "gått upp"} ` +
          `${num(Math.abs(change), "kg", 1)} kg på ${num(CONTEXT_WINDOW_DAYS, "count")} dagar, ` +
          `vilket är ${num(weekly, "kgPerWeek", 2)} kg i veckan.`,
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
  }

  /* --------------------------------------------------------------- plan */

  say("");
  say("PLAN OCH SPÄRRAR");

  if (plan) {
    say(
      `Plan: ${
        plan.goalWeightKg === null
          ? "inget målvikt satt"
          : `mål ${num(plan.goalWeightKg, "kg", 1)} kg`
      }, dagligt mål ${num(plan.targetIntakeKcal, "kcal")} kcal, ` +
        `golv ${num(plan.intakeFloorKcal, "kcal")} kcal.`,
    );
    if (plan.targetRateKgWeek !== null) {
      say(`Planerad takt: ${num(Math.abs(plan.targetRateKgWeek), "kgPerWeek", 2)} kg i veckan.`);
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
        : `, och takten aldrig snabbare än ${num(maxRate, "kgPerWeek", 2)} kg i veckan, ` +
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
        continue;
      }

      say(
        `${macroNames[key]}: mål ${num(target, "grams")} g per dag (${source}). ` +
          perWindow.join(". ") +
          ".",
      );
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
      say(
        `Alkohol ${num(window, "count")} dagar: ${num(total, "drinks", 1)} standardglas ` +
          `totalt, ifyllt på ${num(inWindow.length, "count")} ${dayWord(inWindow.length)}, varav ` +
          `${num(sober, "count")} ${sober === 1 ? "nykter" : "nyktra"}.`,
      );
    }
  }

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

      say(
        `Rörelse ${num(window, "count")} dagar: ${num(sessions.length, "count")} pass, ` +
          `${num(minutes, "minutes")} minuter totalt.`,
      );
    }
  }

  const stepsByDay = dailyLogs.filter((row) => row.steps !== null);
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
      say(
        `Steg ${num(window, "count")} dagar: i snitt ${num(average, "steps")} per dag ` +
          `från ${num(values.length, "count")} ${dayWord(values.length)}.`,
      );
    }
  }

  /* --------------------------------------------- sömn, energi och humör */

  say("");
  say("SÖMN, ENERGI OCH HUMÖR");

  const scales = [
    { key: "sleepHours", label: "Sömn", unit: "hours" as FigureUnit, suffix: " timmar", decimals: 1 },
    { key: "energy", label: "Energi", unit: "scale" as FigureUnit, suffix: " av 5", decimals: 1 },
    { key: "mood", label: "Humör", unit: "scale" as FigureUnit, suffix: " av 5", decimals: 1 },
  ] as const;

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
      parts.push(
        `${num(window, "count")} dagar: snitt ${num(average, scale.unit, scale.decimals)}` +
          `${scale.suffix} från ${num(values.length, "count")} ${dayWord(values.length)}`,
      );
    }

    say(
      parts.length === 0
        ? `${scale.label} är inte ifyllt i fönstret.`
        : `${scale.label}, ${parts.join(". ")}.`,
    );
  }

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
      `${siteNames[site]}: ${num(last.trend, "cm", 1)} cm` +
        (change === null
          ? ""
          : `, ${change.deltaCm < 0 ? "ner" : "upp"} ${num(Math.abs(change.deltaCm), "cm", 1)} cm ` +
            `på ${num(CONTEXT_WINDOW_DAYS, "count")} dagar`),
    );
  }

  if (measured.length === 0) {
    say("Inga mått är loggade.");
  } else {
    for (const line of measured) say(`${line}.`);
  }

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
    const metrics: Record<string, { unit: FigureUnit; suffix: string; decimals: number }> = {
      weight_kg: { unit: "kg", suffix: " kg", decimals: 1 },
      waist_cm: { unit: "cm", suffix: " cm", decimals: 1 },
      chest_cm: { unit: "cm", suffix: " cm", decimals: 1 },
      whtr: { unit: "scale", suffix: "", decimals: 2 },
      log_streak_days: { unit: "count", suffix: " dagar", decimals: 0 },
      sober_days: { unit: "count", suffix: " dagar", decimals: 0 },
    };

    for (const row of open) {
      const shape = metrics[row.metric] ?? { unit: "scale" as FigureUnit, suffix: "", decimals: 1 };
      say(
        `${row.label}: mål ${num(Number(row.targetValue), shape.unit, shape.decimals)}` +
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
      say(`${name}: det finns ingen dag där båda är ifyllda.`);
      continue;
    }

    say(
      // `enough` is the service's own answer, not a threshold recomputed here.
      pane.enough
        ? `${name}: ${num(pane.sampleSize, "count")} dagar där båda finns. Appen ritar dem ` +
          "mot varandra under Samband, men räknar inget samband och påstår ingen orsak."
        : `${name}: bara ${num(pane.sampleSize, "count")} dagar där båda finns, och ` +
          `${num(correlations.minPairs, "count")} behövs innan appen ritar något.`,
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
   * reply may quote.
   */
  const dedupe = (values: number[], decimals: number): number[] => [
    ...new Set(values.map((value) => Number(value.toFixed(decimals)))),
  ];

  return {
    text,
    figures: {
      kcal: dedupe(figures.kcal, 0),
      kg: dedupe(figures.kg, 1),
      percent: dedupe(figures.percent, 0),
      kgPerWeek: dedupe(figures.kgPerWeek, 2),
      grams: dedupe(figures.grams, 0),
      minutes: dedupe(figures.minutes, 0),
      steps: dedupe(figures.steps, 0),
      hours: dedupe(figures.hours, 1),
      drinks: dedupe(figures.drinks, 1),
      cm: dedupe(figures.cm, 1),
      count: dedupe(figures.count, 0),
      scale: dedupe(figures.scale, 1),
    },
    guardrails: { intakeFloorKcal: floor, maxRateKgWeek: maxRate },
    chars: text.length,
  };
}
