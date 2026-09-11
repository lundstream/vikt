import { addDays, buildLoggedDays, currentStreak, eachDay, formatDecimal } from "shared";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import { getInsights } from "../services/insights.service.js";
import { getWeightRows, resolveTrend } from "../services/series.service.js";
import { resolveIntake } from "../services/intake.service.js";
import { getDailyLogs } from "../services/daily.service.js";
import { getHabitsForDay } from "../services/habit.service.js";
import { getActivePlan } from "../services/plan.service.js";
import { listMilestones } from "../repositories/progress.repo.js";

/**
 * What the coach is allowed to see (D139), §6 phase 8b rule 1.
 *
 * **Aggregates, never rows.** Not one `food_entries` line, not one weight
 * reading, not the note somebody wrote about a bad day. How things are going is
 * a dozen derived numbers the app already computes; sending the underlying rows
 * would put a person's whole log through a model to answer "hur ligger jag
 * till", and would be a much larger thing to have to say on the privacy page.
 *
 * **Every figure the reply may state comes from here.** That is not only a
 * privacy rule: `coach-guard.ts` uses this same set as the allowlist of numbers
 * a reply may contain, so this file is also the definition of traceable. A
 * figure the model produces that is not in here is one it invented, and the
 * reply is refused.
 *
 * **Nothing is recomputed.** Every number is read through the service that
 * already produces it for a screen. A coach with its own maintenance figure
 * would eventually disagree with the dashboard, in front of somebody looking at
 * both.
 *
 * **The size is measured and bounded.** The model variant's `num_ctx` has to
 * hold this block, the turns that travel with it, and the answer.
 */

/**
 * The ceiling for the aggregate block, in characters, held by a test.
 *
 * Characters rather than tokens because characters can be counted without a
 * tokenizer. Swedish runs about 3.4 characters per token on these models, so
 * 6 000 is roughly 1 800 tokens; against a variant saved with `num_ctx` 8 192
 * that leaves room for the persona, six turns and a reply, with nothing
 * truncated at the wrong end.
 */
export const CONTEXT_CHAR_BUDGET = 6000;

/** How many past turns travel with a question. The rest stays in the database. */
export const CONTEXT_TURNS = 6;

/** How many days of trend and intake the coach sees. */
export const CONTEXT_WINDOW_DAYS = 28;

export type CoachFigures = {
  kcal: number[];
  kg: number[];
  percent: number[];
  kgPerWeek: number[];
};

export type CoachFacts = {
  /** The block of Swedish the model is given. */
  text: string;
  /**
   * Every number stated in that block: the set a reply may quote. Kept per unit
   * so "1 800 kcal" and "1,8 kg" cannot vouch for each other.
   */
  figures: CoachFigures;
  /** The two limits the post-check enforces in their own right. */
  guardrails: { intakeFloorKcal: number; maxRateKgWeek: number | null };
  chars: number;
};

const round = (value: number): number => Math.round(value);
const oneDecimal = (value: number): string => formatDecimal(value, { decimals: 1 });
const twoDecimals = (value: number): string => formatDecimal(value, { decimals: 2 });

export async function buildCoachFacts(
  userId: string,
  db: Db,
  env: Env,
  asOf: string,
): Promise<CoachFacts> {
  const from = addDays(asOf, -(CONTEXT_WINDOW_DAYS - 1));

  const [insights, trend, weights, intake, dailyLogs, habits, milestones, plan] =
    await Promise.all([
      getInsights(userId, db, asOf, env.SYSTEM_INTAKE_FLOOR_KCAL),
      resolveTrend(userId, db, asOf),
      getWeightRows(userId, db, { from, to: asOf }),
      resolveIntake(userId, db, { from, to: asOf }),
      getDailyLogs(userId, db, { from, to: asOf }),
      getHabitsForDay(userId, db, asOf),
      listMilestones(userId, db),
      getActivePlan(userId, db),
    ]);

  const kcal: number[] = [];
  const kg: number[] = [];
  const percent: number[] = [];
  const kgPerWeek: number[] = [];

  const lines: string[] = [];
  const say = (line: string) => lines.push(line);

  say(`I dag är ${asOf}.`);

  /* ------------------------------------------------------------- the trend */

  const trendNow = trend.at(-1)?.trend ?? null;
  const windowStart = trend.find((point) => point.localDate >= from)?.trend ?? null;

  if (trendNow !== null) {
    kg.push(trendNow);
    say(`Trendvikt nu: ${oneDecimal(trendNow)} kg.`);

    if (windowStart !== null && Math.abs(trendNow - windowStart) >= 0.05) {
      const change = trendNow - windowStart;
      kg.push(Math.abs(change));
      say(
        `Trendvikten har ${change < 0 ? "gått ner" : "gått upp"} ${oneDecimal(Math.abs(change))} kg ` +
          `på ${CONTEXT_WINDOW_DAYS} dagar.`,
      );
      const weekly = Math.abs((change / CONTEXT_WINDOW_DAYS) * 7);
      kgPerWeek.push(weekly);
      say(`Det är ${twoDecimals(weekly)} kg i veckan.`);
    }
  } else {
    say("Ingen trendvikt än: det finns för få vägningar.");
  }

  say(`Vägningar de senaste ${CONTEXT_WINDOW_DAYS} dagarna: ${weights.length}.`);

  /* ---------------------------------------------------------- maintenance */

  const { maintenance } = insights;
  if (maintenance.tdee !== null) {
    kcal.push(maintenance.tdee);
    percent.push(round(maintenance.confidence * 100), round(maintenance.coverage * 100));
    say(
      `Underhållsnivå: ${round(maintenance.tdee)} kcal per dag. ` +
        `Källa: ${maintenance.source === "adaptive" ? "adaptiv, räknad ur din egen data" : "formel"}. ` +
        `Tillförlitlighet ${round(maintenance.confidence * 100)} procent, ` +
        `täckning ${round(maintenance.coverage * 100)} procent av fönstret.`,
    );
    if (maintenance.estimateShare > 0) {
      percent.push(round(maintenance.estimateShare * 100));
      say(
        `${round(maintenance.estimateShare * 100)} procent av den loggade energin i fönstret ` +
          "är uppskattad snarare än mätt.",
      );
    }
  } else {
    say("Ingen underhållsnivå än. Den kräver fler dagar med både vikt och mat.");
  }

  /* --------------------------------------------------------------- plan */

  if (plan) {
    kcal.push(plan.targetIntakeKcal, plan.intakeFloorKcal);
    if (plan.goalWeightKg !== null) kg.push(plan.goalWeightKg);
    say(
      `Plan: ${plan.goalWeightKg === null ? "inget målvikt satt" : `mål ${oneDecimal(plan.goalWeightKg)} kg`}, ` +
        `dagligt mål ${plan.targetIntakeKcal} kcal, golv ${plan.intakeFloorKcal} kcal.`,
    );
    if (plan.targetRateKgWeek !== null) {
      kgPerWeek.push(Math.abs(plan.targetRateKgWeek));
      say(`Planerad takt: ${twoDecimals(Math.abs(plan.targetRateKgWeek))} kg i veckan.`);
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
  kcal.push(floor);
  if (maxRate !== null) kgPerWeek.push(maxRate);
  say(
    `Spärrar appen räknar med: intaget föreslås aldrig under ${floor} kcal per dag` +
      (maxRate === null
        ? "."
        : `, och takten aldrig snabbare än ${twoDecimals(maxRate)} kg i veckan, ` +
          "vilket är 1 procent av kroppsvikten."),
  );

  /* ------------------------------------------------------------- intake */

  const days = [...eachDay(from, asOf)];
  const logged = days
    .map((day) => intake.get(day))
    .filter((value): value is number => value !== undefined && value > 0);

  if (logged.length > 0) {
    const mean = logged.reduce((sum, value) => sum + value, 0) / logged.length;
    kcal.push(round(mean));
    percent.push(round((logged.length / days.length) * 100));
    say(
      `Loggat intag: ${logged.length} av ${days.length} dagar, ` +
        `i snitt ${round(mean)} kcal per loggad dag.`,
    );
  } else {
    say(`Inget loggat intag de senaste ${CONTEXT_WINDOW_DAYS} dagarna.`);
  }

  /* -------------------------------------------------------------- macros */

  const macroNames = {
    protein: "Protein",
    carbs: "Kolhydrater",
    fat: "Fett",
    fiber: "Fiber",
  } as const;

  if (insights.macros) {
    for (const key of ["protein", "carbs", "fat", "fiber"] as const) {
      const macro = insights.macros[key];
      const target = round(macro.targetG);
      const source = macro.overridden ? "ditt eget" : "NNR";
      if (macro.weeklyMeanG === null) {
        say(`${macroNames[key]}: mål ${target} g per dag (${source}), inget veckosnitt än.`);
        continue;
      }
      say(
        `${macroNames[key]}: mål ${target} g per dag (${source}), ` +
          `veckosnitt ${round(macro.weeklyMeanG)} g från ${macro.weeklyDays} dagar.`,
      );
    }
  } else {
    say("Inga makromål: de härleds ur en aktiv plan, och det finns ingen.");
  }

  /* ------------------------------------------------------------- streaks */

  const loggedDays = buildLoggedDays({
    weight: weights.map((row) => ({ localDate: row.localDate })),
    daily: dailyLogs.map((row) => ({ localDate: row.localDate })),
    food: days
      .filter((day) => (intake.get(day) ?? 0) > 0)
      .map((day) => ({ localDate: day })),
  });
  const streak = currentStreak(loggedDays, asOf);
  say(`Loggningsstreck: ${streak.days} dagar i rad.`);

  /* ---------------------------------------------------------- milestones */

  const open = milestones.filter((row) => row.achievedAt === null).slice(0, 5);
  if (open.length > 0) {
    say(
      "Aktiva milstolpar: " +
        open.map((row) => `${row.label} vid ${oneDecimal(Number(row.targetValue))}`).join(", ") +
        ".",
    );
  }

  /* -------------------------------------------------------------- habits */

  if (habits.length > 0) {
    say(
      "Vanor på checklistan i dag: " +
        habits
          .map(
            (habit) =>
              `${habit.name} (${habit.checked ? "avbockad" : "inte avbockad"}` +
              `${habit.streak.days > 0 ? `, ${habit.streak.days} dagar i rad` : ""})`,
          )
          .join(", ") +
        ".",
    );
  }

  const text = lines.join("\n");

  return {
    text,
    figures: {
      kcal: [...new Set(kcal.map(round))],
      kg: [...new Set(kg.map((value) => Number(value.toFixed(1))))],
      percent: [...new Set(percent.map(round))],
      kgPerWeek: [...new Set(kgPerWeek.map((value) => Number(value.toFixed(2))))],
    },
    guardrails: { intakeFloorKcal: floor, maxRateKgWeek: maxRate },
    chars: text.length,
  };
}
