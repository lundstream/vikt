import { HOUSEHOLD_UNITS, parsedPhotoSchema, type ParsedPhotoItem } from "shared";
import type { ChatMessage } from "./client.js";
import { findForbiddenKeys } from "./parse-food.js";

/**
 * A photograph of a plate, turned into rows a food database could hold.
 *
 * The bargain is the text parser's, unchanged: **the model names, the database
 * prices, a person confirms.** What differs is everything the probe found when
 * it pointed four models at real plates (`docs/measurements.md`), and each of
 * those findings is a rule below rather than a hope in the prompt:
 *
 * **Seeing is not the same as not inventing.** A model looked at a steak dinner
 * and produced a carrot. Nothing here can stop that; what it can do is make
 * sure an invented food arrives as a named row a person will read and delete,
 * rather than as a number added to their day.
 *
 * **Amounts are the weak part.** The answers were "stor mängd", "spridd över
 * delar" and "1 portion", which are descriptions of a photograph and not
 * quantities. So an amount is only an amount when the app can turn it into
 * grams, and everything else becomes null and stays null. Coercing "stor mängd"
 * into 150 g would be the app making up a number and attributing it to the
 * person, which is the one thing §2 never permits.
 *
 * **A composite dish comes back thin.** "Kebab pizza" arrived as "Pizza (1 st)".
 * The fix is the line beside the photograph, which travels in this same call.
 */

/**
 * The prompt.
 *
 * The instruction that does the work is "as a Swedish food database has them as
 * rows", which is a sharper rule than either "split everything" or "name the
 * dish". A kebab pizza is one row in such a database, so it is one line. A steak
 * with chips and béarnaise is three rows, so it is three lines. A packaged
 * product is one row under the name on its label, so the brand and the product
 * name are what to write — the search then has an exact string to hit rather
 * than a description to approximate.
 */
export const PHOTO_SYSTEM_PROMPT = `Du tittar på ett fotografi av mat och skriver ned vad som finns på bilden.

Svara ENDAST med JSON i exakt den här formen:
{"items":[{"name":"kebabpizza","amount":{"count":1,"unit":"st"}},{"name":"Felix potatisbullar","amount":null}]}

Regler:
- name: livsmedlets namn på svenska, utan mängd och utan siffror.
- Skriv varje sak så som den står som rad i en svensk livsmedelsdatabas. En
  kebabpizza är EN rad, inte deg och kebab och sås var för sig. En biff med
  pommes och bearnaise är TRE rader, för det är tre livsmedel.
- Är det en förpackad vara: skriv namnet så som det står på förpackningen,
  varumärke och produktnamn. "Felix potatisbullar", inte "potatisbullar".
- amount: mängden, som ett tal och en enhet. Enheten måste vara en av:
  ${HOUSEHOLD_UNITS.join(", ")}.
- Vet du inte mängden, sätt amount till null. Det är ett riktigt svar och det
  vanligaste. Skriv ALDRIG "stor mängd", "en del", "spridd över", "lagom" eller
  liknande. Gissa inte gram.
- Ta bara med mat du faktiskt ser. Hitta inte på tillbehör som brukar ingå.
- Dryck som står bredvid tallriken är inte mat på tallriken. Utelämna den.
- Ange ALDRIG kalorier, energi, protein, kolhydrater, fett eller andra
  näringsvärden, varken som fält eller i namnet. Appen slår upp det själv.
- Lägg inte till fält som inte finns i exemplet.
- Ser du ingen mat alls: {"items":[]}`;

/**
 * The user turn: the photograph, and the words beside it when there were any.
 *
 * Ollama's native endpoint takes images on the message, so the note and the
 * picture are one turn rather than two calls to reconcile. The note is given as
 * what the person says it is, because they know what they ordered and the model
 * only knows what round things look like.
 */
export function parsePhotoMessages(image: string, note?: string): ChatMessage[] {
  const said = note?.trim() ?? "";

  return [
    { role: "system", content: PHOTO_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        said === ""
          ? "Vad är det för mat på bilden?"
          : `Vad är det för mat på bilden? Personen säger: ${said}`,
      images: [image],
    },
  ];
}

export type PhotoParseOutcome =
  | { ok: true; items: ParsedPhotoItem[] }
  | { ok: false; reason: "unusable_output"; detail: string };

/**
 * Nutrition figures written into a name rather than a field.
 *
 * The schema refuses a `kcal` key at any depth, which handles the model being
 * structurally helpful. It cannot handle `"name": "kebabpizza ca 1200 kcal"`,
 * and that is the same claim wearing different clothes: a number the model
 * produced, presented next to a food, in an app whose one rule about this is
 * that the database says what food is worth.
 *
 * So it is cut out of the name. Only when a nutrition word is actually there —
 * a bare number beside a food is an amount, and amounts have their own field
 * and their own rules.
 */
const NUTRITION_IN_TEXT = [
  /\b(?:ca\.?|cirka|ungefär|~|omkring)?\s*\d+(?:[.,]\d+)?\s*(?:k?cal|kcal|kj|kilojoule|kalorier)\b/gi,
  /\b(?:ca\.?|cirka|ungefär|~|omkring)?\s*\d+(?:[.,]\d+)?\s*g?\s*(?:protein|kolhydrater|kolhydrat|fett|fiber|socker)\b/gi,
  /\b(?:protein|kolhydrater|kolhydrat|fett|fiber|socker|energi)\s*:?\s*\d+(?:[.,]\d+)?\s*g?\b/gi,
];

/** A name with any nutrition claim taken out of it, tidied up afterwards. */
export function stripNutrition(name: string): string {
  let cleaned = name;
  for (const pattern of NUTRITION_IN_TEXT) cleaned = cleaned.replace(pattern, " ");

  return cleaned
    // Brackets left holding nothing once the figure inside them is gone.
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-–(]+|[\s,;:.\-–)]+$/g, "")
    .trim();
}

/**
 * The model's answer, read strictly.
 *
 * Same three steps as the text parser, in the same order and for the same
 * reason: parse the JSON, refuse any nutrition key at any depth, then validate
 * the shape. The forbidden-key sweep runs **before** validation because
 * `.strict()` would reject the object without saying why, and "the model tried
 * to send calories" is worth telling apart from "the model sent rubbish".
 */
export function readParsedPhoto(content: string): PhotoParseOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, reason: "unusable_output", detail: "not JSON" };
  }

  const forbidden = findForbiddenKeys(raw);
  if (forbidden.length > 0) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: `nutrition keys: ${forbidden.join(", ")}`,
    };
  }

  const parsed = parsedPhotoSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 300),
    };
  }

  /**
   * Names cleaned here rather than at the boundary, so every caller of this
   * function gets a name with no numbers in it and nobody has to remember.
   * A name that was *only* a nutrition claim is dropped: there is no food left
   * in it to look up.
   */
  const items = parsed.data.items
    .map((item) => ({ ...item, name: stripNutrition(item.name) }))
    .filter((item) => item.name !== "");

  return { ok: true, items };
}
