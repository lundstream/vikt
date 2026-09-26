import { z } from "zod";
import type { ChatMessage } from "./client.js";

/**
 * A photograph of a recipe's ingredient list, transcribed line by line (D195).
 *
 * **The model's whole job is to copy lines.** Splitting a line into amounts,
 * units and a name is `parseRecipeLine` in `shared/recipe-photo.ts`, because
 * the probe showed the model reading every figure right and filing half of
 * them under the wrong field, while the lines it wrote held all of them as
 * printed. The prompt is the one the final probe ran, three times per
 * photograph, verbatim; its outputs, row by row, are in DECISIONS.md, D195.
 *
 * **No example, of anything.** D190 found `qwen3-vl:8b` handing back a
 * transcription prompt's example as its answer; here an example line would be
 * a copyable row, and an example figure is exactly what the probe's own gate
 * checks (the page's "0,39 g" was read as printed, not as a correction).
 */
export const RECIPE_SYSTEM_PROMPT = `Du skriver av ingredienslistan i ett recept som syns i fotografiet: en sida i en kokbok, ett receptkort eller en skärm. Du skriver av det som står. Du räknar aldrig om, avrundar aldrig, rättar aldrig och uppskattar aldrig.

Svara ENDAST med ett JSON-objekt med de här fälten, i den här ordningen:
- title: receptets namn om det syns, annars null.
- yield: det som står om hur mycket receptet räcker till, ordagrant så som det är tryckt. Står inget: null.
- rows: ingredienserna i den ordning de står, en post per ingrediens.

Varje post i rows har:
- line: hela ingrediensraden så som den är tryckt, med mängder, enheter, parenteser och kommatecken. En ingrediens som bryts över flera tryckta rader skrivs ihop till en rad. Ett ord som är avstavat vid radslutet skrivs ihop till ett ord, utan bindestreck.
- section: rubriken som ingrediensen står under, om listan är uppdelad under rubriker. Annars null.

Regler:
- En rubrik i ingredienslistan är ingen ingrediens. Den står som section på ingredienserna under den.
- Brödtext, beskrivningar och de numrerade stegen i tillagningen är inga ingredienser. Ta bara med ingredienslistan.
- Text från en annan spalt, och text som är avskuren vid bildens kant, tar du inte med.
- En hänvisning till en annan sida som står i ingredienslistan skriver du av som den står.
- Skriv av varje tal exakt som det står, med decimalkomma där det står ett, även ett tal som ser fel ut. Rätta aldrig ett tal.
- Läs varje ord bokstav för bokstav.
- Bilden kan vara roterad, sned, suddig eller fotograferad av en skärm. Läs den ändå, och hoppa över det du inte kan läsa.
- Ser du inget recept alls: null i title och yield och en tom lista i rows.`;

const text = { type: ["string", "null"] };

/** The shape, enforced by Ollama while it samples (`format`). */
export const RECIPE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: text,
    yield: text,
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: { line: { type: "string" }, section: text },
        required: ["line", "section"],
      },
    },
  },
  required: ["title", "yield", "rows"],
};

export function readRecipeMessages(image: string): ChatMessage[] {
  return [
    { role: "system", content: RECIPE_SYSTEM_PROMPT },
    { role: "user", content: "Skriv av ingredienslistan i receptet på bilden.", images: [image] },
  ];
}

const transcriptionSchema = z.object({
  title: z.string().trim().max(200).nullable(),
  yield: z.string().trim().max(120).nullable(),
  rows: z
    .array(
      z.object({
        line: z.string().trim().max(300),
        section: z.string().trim().max(120).nullable(),
      }),
    )
    .max(60),
});
export type RecipeTranscription = z.infer<typeof transcriptionSchema>;

export type RecipeReadOutcome =
  | { ok: true; recipe: RecipeTranscription }
  | { ok: false; reason: "unusable_output"; detail: string };

/**
 * The model's answer, read strictly. An empty line is dropped, because it is
 * no row; anything malformed refuses the reply, because a list the app has to
 * guess its way through is not a transcription.
 */
export function readRecipe(content: string): RecipeReadOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, reason: "unusable_output", detail: "not JSON" };
  }
  const parsed = transcriptionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "unusable_output",
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }
  const blank = (value: string | null) => (value === null || value === "" ? null : value);
  return {
    ok: true,
    recipe: {
      title: blank(parsed.data.title),
      yield: blank(parsed.data.yield),
      rows: parsed.data.rows
        .filter((row) => row.line !== "")
        .map((row) => ({ line: row.line, section: blank(row.section) })),
    },
  };
}
