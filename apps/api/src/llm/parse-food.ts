import {
  FORBIDDEN_MODEL_KEYS,
  parsedFoodSchema,
  type ParsedFoodItem,
} from "shared";
import type { ChatMessage } from "./client.js";

/**
 * Turning "två ägg, en skiva rågbröd med smör och kaffe" into a list of foods.
 *
 * The model's job is **naming and portioning, nothing else**. §6 phase 8 states
 * it directly: it outputs `{name, estimatedGrams, confidence}` and never a
 * calorie or a macro, because the backend matches the names against
 * `food_items` and computes the nutrition from there.
 *
 * That division is not fussiness about correctness for its own sake. A language
 * model asked for calories will produce confident, plausible, wrong ones, and
 * nothing downstream can tell them from the right ones — and in this app they
 * would flow straight into the intake series, out of there into the §4.2
 * adaptive maintenance figure, and out of *there* into the daily target and
 * both projections. One invented number becomes every number.
 */

/**
 * The system prompt.
 *
 * In Swedish because the input is, and a model asked to work in one language
 * and answer in another spends its attention on the translation. The output
 * shape is given as a literal example rather than described, which these models
 * follow far more reliably.
 */
export const PARSE_SYSTEM_PROMPT = `Du delar upp en text om mat i enskilda livsmedel.

Svara ENDAST med JSON i exakt den här formen:
{"items":[{"name":"ägg","portion":{"count":2,"unit":"ägg"},"estimatedGrams":110,"confidence":0.9}]}

Regler:
- name: livsmedlets namn på svenska, i grundform och utan mängd. "ägg", inte "två ägg".
- portion: så som mängden faktiskt sägs, uppdelad i antal och enhet. "fem tunna skivor" blir {"count":5,"unit":"skivor"}, "en halv burk" blir {"count":0.5,"unit":"burk"}, "3 dl" blir {"count":3,"unit":"dl"}.
- Skriv enheten i den form som passar antalet: "1 skiva", "5 skivor".
- Säger texten ingen mängd alls, sätt portion till null.
- estimatedGrams: hur många gram det rör sig om totalt, som ett tal. Appen använder den bara när den inte vet vad en portion väger.
- confidence: 0 till 1, hur säker du är på att du tolkat mängden rätt.
- Ange ALDRIG kalorier, energi, protein, kolhydrater, fett eller andra näringsvärden. Appen slår upp det själv.
- Lägg inte till fält som inte finns i exemplet.
- Ta med varje livsmedel för sig. "smörgås med ost" är två rader: bröd och ost.
- Hittar du ingen mat alls: {"items":[]}`;

export function parseFoodMessages(text: string): ChatMessage[] {
  return [
    { role: "system", content: PARSE_SYSTEM_PROMPT },
    { role: "user", content: text },
  ];
}

export type ParseOutcome =
  | { ok: true; items: ParsedFoodItem[] }
  | { ok: false; reason: "unusable_output"; detail: string };

/**
 * Reads the model's reply, and refuses anything that is not exactly the agreed
 * shape.
 *
 * Two checks, deliberately overlapping. The schema is `.strict()`, so an extra
 * key is already a parse failure; the explicit scan for forbidden keys exists
 * because it survives someone later relaxing the schema for an unrelated
 * reason, and because it can say *which* rule was broken in the log rather than
 * "unrecognized key".
 *
 * A refusal is not an error the user sees. It degrades to the manual path like
 * every other unavailability in this layer.
 */
export function readParsedFood(content: string): ParseOutcome {
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

  const parsed = parsedFoodSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: parsed.error.issues[0]?.message ?? "wrong shape",
    };
  }

  return { ok: true, items: parsed.data.items };
}

/**
 * Any nutrition-shaped key, anywhere in the reply.
 *
 * Exported because the recipe generator runs its output through the same
 * check (§6: "output goes through the same parse-and-match path"). One rule,
 * one implementation, one place to change it.
 *
 * Walks the whole structure rather than checking the item objects, because a
 * model that decides to be helpful puts the calories somewhere new: a
 * `totals` object beside `items`, a `summary` string, a per-item `nutrition`.
 * The rule is that none of it is welcome, at any depth.
 */
export function findForbiddenKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) findForbiddenKeys(entry, found);
    return found;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const normalised = key.toLowerCase().replace(/[^a-z]/g, "");
      if ((FORBIDDEN_MODEL_KEYS as readonly string[]).includes(normalised)) found.push(key);
      findForbiddenKeys(child, found);
    }
  }

  return found;
}
