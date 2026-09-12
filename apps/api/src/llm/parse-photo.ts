import type { ChatMessage } from "./client.js";
import { PARSE_SYSTEM_PROMPT } from "./parse-food.js";

/**
 * A photograph of a plate, turned into the same list of foods a sentence gives.
 *
 * The photo path is the text path with a different input, and that is the whole
 * design. The model **names** what it can see; the database **prices** it; a
 * person confirms before anything is written. Nothing here is allowed to be an
 * exception to that, which is why this file imports the text parser's rules
 * instead of restating them: two prompts saying nearly the same thing is how one
 * of them quietly stops saying it.
 *
 * The probe that preceded this (`docs/measurements.md`) settled what the prompt
 * has to work around:
 *
 * - **Seeing is not the same as not inventing.** One model looked at a plate and
 *   produced a carrot that was not there. So the prompt asks for what is
 *   visible and nothing beyond it, and the confirm step stays mandatory.
 * - **A composite dish comes back thin.** A kebab pizza was "Pizza (1 st)". The
 *   optional note beside the photograph exists for exactly that, and it goes
 *   into this same call rather than a second one, because a second call would
 *   be a second answer to reconcile with the first.
 */

/**
 * What the photograph adds to the text parser's rules.
 *
 * Appended rather than replacing them: the output shape, the ban on nutrition
 * figures and the one-food-per-row rule are the same rules, and a reader should
 * be able to see that they are the same rules.
 */
export const PHOTO_SYSTEM_PROMPT = `${PARSE_SYSTEM_PROMPT}

Bilden är ett fotografi av mat. Samma regler gäller, med tillägget:

- Ta bara med mat du faktiskt ser på bilden. Gissa aldrig fram något som kan
  tänkas höra till rätten men inte syns.
- Dryck som står bredvid tallriken är inte mat på tallriken. Utelämna den.
- Ser du ingen mat alls: {"items":[]}`;

/**
 * The user turn: the photograph, and the words beside it when there were any.
 *
 * Ollama's native endpoint takes images on the message, so the note and the
 * picture are one turn rather than two. The note is presented as *what the
 * person says it is*, not as a correction to be weighed against the image,
 * because the person knows what they ordered and the model only knows what
 * round things look like.
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
