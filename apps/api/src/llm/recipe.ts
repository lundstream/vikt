import { generatedRecipeSchema, type RecipeBudget } from "shared";
import { findForbiddenKeys } from "./parse-food.js";
import type { ChatMessage } from "./client.js";

/**
 * A recipe from what is in the fridge, inside what is left of the day.
 *
 * §6 phase 8 is precise about the part that matters: the **output goes through
 * the same parse-and-match path**, so the recipe's nutrition comes from the
 * database rather than the model. That is why `items` is the parser's shape
 * exactly — one pipeline, one guard, one place a number could be smuggled in
 * and one place that refuses it.
 *
 * The generation itself is the large model's job, and it is slow: eight seconds
 * warm on this hardware, thirty-one from cold. That is fine for a deliberate
 * "suggest me something" press, and it is why this does not share the parser's
 * short interactive budget.
 */

/**
 * How the day's remaining room is put to the model.
 *
 * Written as a sentence rather than JSON because these models follow prose
 * constraints better than they follow a schema of numbers, and because the
 * honest version has a hedge in it: a day that is only partly labelled has a
 * *floor* for what has been eaten (D55), so what is left is an upper bound. A
 * bound stated as a fact is the kind of small lie that ends up on a plate.
 */
export function describeBudget(budget: RecipeBudget): string {
  /**
   * The day's target already reached.
   *
   * `remainingBudget` clamps at zero, so zero is not "almost none left", it is
   * "past it". Passing that through as "högst 0 kcal" would be an instruction
   * no recipe can satisfy, and an instruction that cannot be followed teaches
   * the model to disregard the budget generally — which is exactly what it did
   * when this was first tried against the real model.
   *
   * So it becomes a different request, not an impossible one. And the wording
   * stays flat: §3 rules out a failure state, and a person who has eaten their
   * day and is standing at the fridge is having a normal evening, not a
   * failing one.
   */
  if (budget.kcal !== null && budget.kcal < 1) {
    return "Dagens mål är redan nått. Föreslå något litet och enkelt.";
  }

  const parts: string[] = [];
  if (budget.kcal !== null) parts.push(`${Math.round(budget.kcal)} kcal`);
  if (budget.proteinG !== null) parts.push(`${Math.round(budget.proteinG)} g protein`);
  if (budget.carbsG !== null) parts.push(`${Math.round(budget.carbsG)} g kolhydrater`);
  if (budget.fatG !== null) parts.push(`${Math.round(budget.fatG)} g fett`);

  if (parts.length === 0) {
    // No plan, so no budget. Saying "0 kcal left" would be a fabricated limit.
    return "Det finns ingen dagsbudget att ta hänsyn till. Föreslå en normal portion.";
  }

  const lead = budget.approximate
    ? "Ungefär så här mycket är kvar i dag, högst"
    : "Så här mycket är kvar i dag";

  return `${lead}: ${parts.join(", ")}.`;
}

/**
 * The system prompt.
 *
 * Written in Swedish, and that is load-bearing rather than stylistic. A model
 * asked in English to answer in Swedish composes in English and translates,
 * which is how "drain the pasta" arrived as "dränka pastan" — fluent Swedish,
 * and an instruction to drown it. The completeness validator catches that one;
 * instructing in the target language is what stops it being produced.
 *
 * The shape is a literal example rather than a description, which these models
 * follow far more reliably, and the rules that matter are written as
 * prohibitions because a prohibition survives paraphrase.
 */
export const RECIPE_SYSTEM_PROMPT = `Du är en svensk kock och skriver recept på svenska.

Svara ENDAST med JSON i exakt den här formen:
{"title":"Omelett med spenat","steps":["Hacka spenaten.","Vispa äggen och stek dem i smör i fem minuter.","Salta och peppra, servera."],"items":[{"name":"ägg","portion":{"count":2,"unit":"ägg"},"estimatedGrams":120,"confidence":0.9}]}

Regler för innehållet:
- Använd i första hand det som finns hemma. Lägg till på sin höjd salt, peppar och vatten.
- title: kort namn på rätten.
- items: varje råvara för sig, med namn i grundform.
- portion: hur råvaran räknas i köket, till exempel {"count":2,"unit":"ägg"} eller {"count":1,"unit":"citron"} eller {"count":1.5,"unit":"dl"}. Utelämna den bara när råvaran verkligen vägs, som köttfärs.
- estimatedGrams: ungefärlig vikt i gram för hela mängden.
- Ange ALDRIG kalorier, energi, protein, kolhydrater, fett eller andra näringsvärden. Varken i items, i title eller i steps. Appen räknar ut det själv ur sin livsmedelsdatabas.
- Håll portionen inom det som är kvar av dagen.

Regler för steps, ett steg per mening, högst åtta:
- Receptet ska gå att laga efter. Sluta inte innan maten är färdig och uppäten på tallriken.
- Använder du ugn: skriv alltid både temperatur i grader och tid i minuter.
- Steker eller kokar du: skriv hur länge.
- Varje råvara i items ska användas i minst ett steg.
- Skriv ut kryddningen. "Salta och peppra" är ett eget steg om det behövs.
- Sista steget avslutar rätten, till exempel "Servera med potatisen."
- Skriv naturlig svenska. Pasta hälls av, den dränks inte.`;


/**
 * What may be assumed to be in the kitchen (§6 phase 8).
 *
 * The two kinds are described differently on purpose. Negligible staples are
 * given as "available, need not be listed"; calorie-bearing ones are given as
 * "available, **and must appear in items**", because that is the difference
 * that matters: three tablespoons of oil is roughly 360 kcal, and a recipe that
 * uses it without listing it produces a food entry short by that much, which
 * lands in the series TDEE is computed from.
 */
function describeStaples(staples: { name: string; negligible: boolean }[]): string {
  if (staples.length === 0) return "";

  const silent = staples.filter((s) => s.negligible).map((s) => s.name);
  const counted = staples.filter((s) => !s.negligible).map((s) => s.name);

  const lines: string[] = [];
  if (silent.length > 0) {
    lines.push(
      `Följande finns alltid hemma och behöver inte stå i items: ${silent.join(", ")}.`,
    );
  }
  if (counted.length > 0) {
    lines.push(
      `Följande finns också hemma, men om du använder dem MÅSTE de stå i items med mängd: ${counted.join(", ")}.`,
    );
  }

  return lines.join("\n");
}

/**
 * What went wrong last time, for the second attempt (D74).
 *
 * Named rules rather than the raw text. Handing a model back its own broken
 * recipe invites it to patch the sentence that was quoted and leave the others;
 * naming the rule asks for a recipe that satisfies it, which is what was wanted
 * the first time.
 */
function describeFailures(failures: { rule: string }[]): string {
  if (failures.length === 0) return "";

  const asked: Record<string, string> = {
    oven_without_temperature: "Skriv ut ugnstemperaturen i grader.",
    oven_without_time: "Skriv ut tiden i minuter.",
    unused_ingredient: "Använd varje råvara i items i minst ett steg.",
    stops_before_cooked: "Laga färdigt rätten och avsluta med hur den serveras.",
    seasoning_unstated: "Skriv ut kryddningen som ett eget steg.",
    translated_english: "Skriv naturlig svensk matlagningssvenska.",
  };

  const unique = [...new Set(failures.map((failure) => failure.rule))];
  return `Ditt förra förslag dög inte. Rätta det här: ${unique
    .map((rule) => asked[rule] ?? rule)
    .join(" ")}`;
}

export function recipeMessages(
  have: string,
  budget: RecipeBudget,
  staples: { name: string; negligible: boolean }[] = [],
  failures: { rule: string }[] = [],
): ChatMessage[] {
  const parts = [
    describeBudget(budget),
    describeStaples(staples),
    `Hemma finns: ${have}`,
    describeFailures(failures),
  ].filter((part) => part !== "");

  return [
    { role: "system", content: RECIPE_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n") },
  ];
}

export type RecipeOutcome =
  | {
      ok: true;
      title: string;
      steps: string[];
      items: {
        name: string;
        estimatedGrams: number;
        confidence: number;
        portion?: { count: number; unit: string } | null;
      }[];
    }
  | { ok: false; reason: "unusable_output"; detail: string };

/**
 * A number next to an energy word, anywhere in the prose.
 *
 * The key walk cannot see this one. A recipe has free text in it, and "Stek
 * äggen (ca 300 kcal)" puts an invented figure in front of the user inside a
 * field that is supposed to be instructions — with the app's own, correct,
 * database-derived total sitting a few pixels away contradicting it.
 *
 * Matches a figure adjacent to a unit in either order, so both "300 kcal" and
 * "kcal: 300" are caught, while prose that merely mentions the word is not.
 */
const ENERGY_CLAIM =
  /(\d[\d\s.,]*)\s*(kcal|kalorier|kj|gram protein|g protein|g kolhydrater|g fett)\b|\b(kcal|kalorier|protein|kolhydrater|fett)\s*[:=]\s*\d/i;

export function readGeneratedRecipe(content: string): RecipeOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, reason: "unusable_output", detail: "not JSON" };
  }

  const offending = findForbiddenKeys(raw);
  if (offending.length > 0) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: `model produced nutrition fields: ${offending.slice(0, 5).join(", ")}`,
    };
  }

  const parsed = generatedRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: parsed.error.issues[0]?.message ?? "wrong shape",
    };
  }

  const prose = [parsed.data.title, ...parsed.data.steps].join("\n");
  const claim = ENERGY_CLAIM.exec(prose);
  if (claim) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: `model stated nutrition in prose: ${claim[0].slice(0, 40)}`,
    };
  }

  return { ok: true, ...parsed.data };
}
