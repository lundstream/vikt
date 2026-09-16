import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUser, localDate, type TestUser } from "./factories.js";
import { testEnv, useTestApp } from "./harness.js";
import type { Db } from "../src/db/index.js";
import {
  activityLog,
  dailyLog,
  foodEntries,
  foodItems,
  manualIntake,
  measurementLog,
  plans,
  weightLog,
} from "../src/db/schema.js";
import {
  buildCoachFacts,
  CONTEXT_CHAR_BUDGET,
  FIGURE_UNITS,
  type CoachFacts,
} from "../src/llm/coach-context.js";
import { checkSentence, figuresIn } from "../src/llm/coach-guard.js";
import { INTERPRETATIONS, MEANING_PREFIX } from "../src/llm/coach-meaning.js";

/**
 * The data sheet (D155).
 *
 * What this holds is the part that is mechanical, and it is the part that had
 * gone wrong: the coach was given a trend and a rate and then asked what
 * somebody was eating, and answered, correctly, that it only saw summaries.
 *
 * Three properties, and the third is the one worth having:
 *
 * **The domains are there.** Food, alcohol, movement, sleep and the rest, over
 * both windows, because a question about "mitt upplägg" is a question about all
 * of them at once.
 *
 * **An empty domain says so with the data as subject.** Never a zero: "0 pass"
 * claims somebody sat still for a week, and what is true is that nothing was
 * logged.
 *
 * **Every number in the sheet is traceable to itself.** The sheet is the
 * definition of what a reply may quote, so running the guard over the sheet's
 * own sentences must pass — a figure written into the text that did not join
 * the allowlist would be one the coach is refused for repeating, which is the
 * worst kind of false refusal because the app put the number there.
 */

const ctx = useTestApp();
const env = testEnv();

/**
 * Rows written straight into the open transaction rather than through the API.
 *
 * The harness offers `db` for exactly this, and here it is the difference
 * between a suite that runs in seconds and one that runs in minutes: this
 * account needs four weeks in six domains, which is about a hundred and fifty
 * writes, and every one of them through `inject` recomputes a trend on the way
 * back. Nothing under test is on the write path; what is under test is what the
 * sheet says about rows that exist.
 */
async function busyAccount(db: Db, user: TestUser): Promise<void> {
  const userId = user.userId;
  const day = (back: number) => localDate(-back);
  const days = [...Array(28).keys()];

  await db.insert(weightLog).values(
    days
      .filter((back) => back % 2 === 0)
      .map((back) => ({
        userId,
        clientUuid: randomUUID(),
        localDate: day(back),
        weightKg: (90 - back * 0.05).toFixed(2),
      })),
  );

  await db.insert(manualIntake).values(
    days.map((back) => ({
      userId,
      clientUuid: randomUUID(),
      localDate: day(back),
      kcal: 2000 + (back % 5) * 60,
    })),
  );

  await db.insert(dailyLog).values(
    days.map((back) => ({
      userId,
      clientUuid: randomUUID(),
      localDate: day(back),
      sleepHours: (7 + (back % 3) * 0.5).toFixed(1),
      energy: 3 + (back % 3),
      mood: 3 + (back % 2),
      steps: 7000 + (back % 4) * 900,
      alcoholUnits: (back % 7 === 0 ? 2 : 0).toFixed(1),
    })),
  );

  await db.insert(activityLog).values(
    days
      .filter((back) => back % 3 === 0)
      .map((back) => ({
        userId,
        clientUuid: randomUUID(),
        localDate: day(back),
        activityType: "walk",
        durationMin: 35,
        intensity: 3,
        kcalEstimate: 150,
      })),
  );

  await db.insert(measurementLog).values(
    days
      .filter((back) => back % 9 === 0)
      .map((back) => ({
        userId,
        clientUuid: randomUUID(),
        localDate: day(back),
        waistCm: (95 - back * 0.05).toFixed(1),
      })),
  );

  const [item] = await db
    .insert(foodItems)
    .values({
      source: "manual",
      name: "Havregrynsgröt",
      kcalPer100: "60.00",
      proteinPer100: "2.50",
      carbsPer100: "9.00",
      fatPer100: "1.20",
      fiberPer100: "1.50",
      createdBy: userId,
    })
    .returning({ id: foodItems.id });

  await db.insert(plans).values({
    userId,
    name: "Test",
    startDate: day(27),
    goalWeightKg: "85.00",
    targetIntakeKcal: 2000,
    intakeFloorKcal: 1500,
    targetRateKgWeek: "0.40",
    startWeightKg: "90.00",
    tdeeAtWrite: "2400.00",
    tdeeSourceAtWrite: "formula",
  });

  await db.insert(foodEntries).values(
    [...Array(7).keys()].map((back) => ({
      userId,
      clientUuid: randomUUID(),
      localDate: day(back),
      mealSlot: "breakfast" as const,
      foodItemId: item!.id,
      grams: "300.0",
      kcal: "180.0",
      proteinG: "7.5",
      carbsG: "27.0",
      fatG: "3.6",
      fiberG: "4.5",
      confirmed: true,
    })),
  );
}

/**
 * A plan and seven days of food, and nothing else, so the macro block is the
 * only thing that varies (D55, addendum 2026-09-15).
 *
 * `partial` adds a dinner as large as the breakfast that carries no macros, so
 * every day is half covered. `food: false` logs manual intake only, which
 * carries no macros at all.
 */
async function macroAccount(
  db: Db,
  user: TestUser,
  { partial, food }: { partial: boolean; food: boolean },
): Promise<void> {
  const userId = user.userId;
  const day = (back: number) => localDate(-back);
  const week = [...Array(7).keys()];

  await db.insert(plans).values({
    userId,
    name: "Test",
    startDate: day(27),
    goalWeightKg: "85.00",
    targetIntakeKcal: 2000,
    intakeFloorKcal: 1500,
    targetRateKgWeek: "0.40",
    startWeightKg: "90.00",
    tdeeAtWrite: "2400.00",
    tdeeSourceAtWrite: "formula",
  });

  if (!food) {
    await db.insert(manualIntake).values(
      week.map((back) => ({ userId, clientUuid: randomUUID(), localDate: day(back), kcal: 1800 })),
    );
    return;
  }

  const [item] = await db
    .insert(foodItems)
    .values({
      source: "manual",
      name: "Kvarg",
      kcalPer100: "100.00",
      proteinPer100: "6.00",
      carbsPer100: "12.00",
      fatPer100: "3.00",
      fiberPer100: "1.20",
      createdBy: userId,
    })
    .returning({ id: foodItems.id });

  await db.insert(foodEntries).values(
    week.flatMap((back) => [
      {
        userId,
        clientUuid: randomUUID(),
        localDate: day(back),
        mealSlot: "breakfast" as const,
        foodItemId: item!.id,
        grams: "500.0",
        kcal: "500.0",
        proteinG: "30.0",
        carbsG: "60.0",
        fatG: "15.0",
        fiberG: "6.0",
        confirmed: true,
      },
      ...(partial
        ? [
            {
              userId,
              clientUuid: randomUUID(),
              localDate: day(back),
              mealSlot: "dinner" as const,
              foodItemId: item!.id,
              grams: "500.0",
              kcal: "500.0",
              proteinG: null,
              carbsG: null,
              fatG: null,
              fiberG: null,
              confirmed: true,
            },
          ]
        : []),
    ]),
  );
}

function macroBlock(facts: CoachFacts): string {
  return facts.text.slice(facts.text.indexOf("MAKRON MOT DINA EGNA MÅL"), facts.text.indexOf("ALKOHOL"));
}

describe("macro sums in the sheet (D55, addendum 2026-09-15)", () => {
  it("states a complete week as a plain snitt", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await macroAccount(db, user, { partial: false, food: true });

    const block = macroBlock(await buildCoachFacts(user.userId, db, env, localDate()));
    const protein = block.split("\n").find((line) => line.startsWith("Protein:"))!;

    expect(protein).toContain("7 dagar: snitt 30 g från 7 loggade dagar");
    expect(protein).not.toContain("minst");
  });

  it("says minst and the share of the energy that carries it for a partial week", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await macroAccount(db, user, { partial: true, food: true });

    const block = macroBlock(await buildCoachFacts(user.userId, db, env, localDate()));
    const protein = block.split("\n").find((line) => line.startsWith("Protein:"))!;

    expect(protein).toContain("7 dagar: snitt minst 30 g från 7 loggade dagar");
    expect(protein).toContain("varav 7 med ofullständiga uppgifter");
    expect(protein).toContain("50 procent av energin har uppgift om protein");
    // No complete day, so nothing is claimed about being under the target.
    expect(protein).not.toContain("under målet");
  });

  it("says there is nothing only when no logged food carries the macro", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await macroAccount(db, user, { partial: false, food: false });

    const block = macroBlock(await buildCoachFacts(user.userId, db, env, localDate()));

    expect(block).toContain("Ingen loggad mat har uppgift om protein, så det finns inget snitt.");
    expect(block).not.toContain("snitt minst");
  });
});

describe("the sheet the coach is given", () => {
  it("covers every domain the question can be about", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await busyAccount(db, user);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());

    for (const heading of [
      "VIKT OCH TREND",
      "INTAG MOT UNDERHÅLL",
      "MAKRON MOT DINA EGNA MÅL",
      "ALKOHOL",
      "RÖRELSE OCH STEG",
      "SÖMN, ENERGI OCH HUMÖR",
      "VANOR",
      "MÅTT",
      "SAMBAND",
    ]) {
      expect(facts.text, `missing section: ${heading}`).toContain(heading);
    }

    // Both windows, in every domain that has a window.
    expect(facts.text).toContain("7 dagar:");
    expect(facts.text).toContain("28 dagar:");

    // The names of what was eaten, and nothing else about it.
    expect(facts.text).toContain("Havregrynsgröt");
    expect(facts.text).toContain("bara namnen");
  });

  /**
   * Every domain says what it means, and the app is the one saying it (D171).
   *
   * The rule used to ask the model for this sentence and it produced one in six
   * live replies. The line is written here now, chosen from a closed set by the
   * state the domain is in, so what a test can check is that no domain is left
   * without one for the model to fill in.
   */
  it("says what each domain means, from its own closed set", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await busyAccount(db, user);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());
    const lines = facts.text.split("\n").filter((line) => line.startsWith(MEANING_PREFIX));

    // Ten domains carry one: weight, intake, protein, fibre, alcohol, activity,
    // steps, sleep, habits and measurements.
    expect(lines.length).toBe(10);

    // Each is one of the reviewed strings, not something assembled at runtime.
    const known = new Set(
      Object.values(INTERPRETATIONS).flatMap((domain) => Object.values(domain)),
    );
    for (const line of lines) {
      expect(known.has(line.slice(MEANING_PREFIX.length).trim()), line).toBe(true);
    }
  });

  /**
   * The whole reason the sheet exists. Before it, the sheet carried a trend, a
   * rate and a macro mean, and the model said so when asked about food.
   */
  it("names what was eaten, without a figure attached to it", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await busyAccount(db, user);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());
    const foodBlock = facts.text.slice(facts.text.indexOf("MAT DE SENASTE"));

    expect(foodBlock).toContain("Havregrynsgröt");
    // 300 g is what was logged, and it is not here.
    expect(foodBlock).not.toContain("300");
    expect(foodBlock).not.toContain("kcal");
  });

  /**
   * The allowlist is built by the same call that writes the text, so this is
   * really a test that nothing can write a number any other way.
   */
  it("puts every number it states into the traceable set", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await busyAccount(db, user);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());

    const untraceable: string[] = [];
    for (const line of facts.text.split("\n")) {
      // The sheet's own sentences, checked with the reply's own check.
      const verdict = checkSentence(line, facts);
      if (!verdict.ok && verdict.reason === "untraceable") {
        untraceable.push(`${verdict.detail} in: ${line}`);
      }
    }

    expect(untraceable, "the sheet states figures a reply could not repeat").toEqual([]);
    // And it really did find figures, so the check above is not vacuous.
    expect(figuresIn(facts.text).length).toBeGreaterThan(20);
  });

  it("fits the budget", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await busyAccount(db, user);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());

    expect(facts.chars).toBe(facts.text.length);
    expect(facts.chars).toBeLessThanOrEqual(CONTEXT_CHAR_BUDGET);
  });

  it("keeps a unit per figure, with no unit left unaccounted for", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await busyAccount(db, user);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());

    for (const unit of FIGURE_UNITS) {
      expect(facts.figures[unit], `no bucket for ${unit}`).toBeDefined();
    }
    // A busy account fills the ones the sheet is actually about.
    for (const unit of ["kcal", "kg", "grams", "minutes", "steps", "hours", "count"] as const) {
      expect(facts.figures[unit].length, `nothing recorded for ${unit}`).toBeGreaterThan(0);
    }
  });
});

describe("an account with nothing logged", () => {
  /**
   * The rule D140's addendum put in the prompt, applied to the sheet itself: a
   * domain with nothing in it is described with the data as the subject, and a
   * zero is never used to mean an absence.
   */
  it("says each domain is not filled in, with the data as the subject", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());

    for (const sentence of [
      "Inga vägningar är loggade",
      "inget intag är loggat",
      "Alkohol är inte ifylld",
      "Ingen rörelse är loggad",
      "Steg är inte ifyllda",
      "Sömn är inte ifyllt",
      "Energi är inte ifyllt",
      "Humör är inte ifyllt",
      "Inga vanor är upplagda",
      "Inga mått är loggade",
      "Ingen mat är loggad",
    ]) {
      expect(facts.text, `missing absence line: ${sentence}`).toContain(sentence);
    }
  });

  it("never says a domain is zero", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const facts = await buildCoachFacts(user.userId, db, env, localDate());

    // As whole figures, not as substrings: "1 200 kcal" ends in "0 kcal" and is
    // the plan's floor, which is a real number and not an absence.
    for (const zero of [
      /\b0 pass\b/,
      /\b0 standardglas\b/,
      /\b0 minuter\b/,
      /\b0 steg\b/,
      /\b0 timmar\b/,
      /\b0 vägningar\b/,
      /\b0 kcal\b/,
      /\b0 dagar\b/,
      /\b0 g\b/,
    ]) {
      expect(facts.text, `stated an absence as a measurement: ${zero}`).not.toMatch(zero);
    }
  });

  /** Empty or not, the sheet still has to be checkable against itself. */
  it("still states nothing a reply could not repeat", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const facts: CoachFacts = await buildCoachFacts(user.userId, db, env, localDate());

    for (const line of facts.text.split("\n")) {
      const verdict = checkSentence(line, facts);
      if (!verdict.ok) expect(verdict.reason, `${verdict.detail} in: ${line}`).not.toBe("untraceable");
    }
  });
});
