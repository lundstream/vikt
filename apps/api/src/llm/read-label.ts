import { labelTranscriptionSchema, type LabelTranscription } from "shared";
import type { ChatMessage } from "./client.js";

/**
 * A photograph of a nutrition declaration, transcribed (Phase 14, D190).
 *
 * **The one place in this app where a model returns nutrition figures**, and
 * D5 is amended to say exactly that and no more: transcription of a printed
 * declaration, never estimation. What makes it transcription is not this
 * prompt, which can only ask; it is the three guards around it, in
 * `shared/label.ts` (the figures must add up), the sheet (a person confirms
 * each figure beside the photo) and the food it becomes (an ordinary food of
 * their own, marked "från etikett", no estimate).
 *
 * ## No example object, and why
 *
 * Every other prompt in this layer shows the model a filled-in example, and
 * the probe tried that here first. `qwen3-vl:8b` returned the example: the
 * same product name and every figure, for two of the three photographs, three
 * runs out of three. A transcription prompt cannot carry numbers, because
 * numbers are what gets transcribed. So the fields are described in words and
 * the shape is enforced by `LABEL_SCHEMA`, which Ollama applies while
 * sampling; the verbatim outputs of both probes are in DECISIONS.md, D190.
 */
export const LABEL_SYSTEM_PROMPT = `Du skriver av näringsdeklarationen som är tryckt på en förpackning i fotografiet. Du skriver av det som står. Du uppskattar aldrig och räknar aldrig ut något.

Svara ENDAST med ett JSON-objekt med de här fälten:
- name: produktens namn så som det står på förpackningen, om det syns på bilden. Syns inget namn: null. Hitta aldrig på ett namn.
- column: rubriken på kolumnen du läste, så som den står, till exempel "per 100 g".
- basis: "100g" eller "100ml", efter vad kolumnen gäller.
- columns: hur många kolumner med siffror deklarationen har. Per 100 g, per portion och procent av referensintag räknas var för sig.
- energyKj, energyKcal: energin i den kolumnen, i kJ och i kcal.
- fat: fett totalt. saturatedFat: varav mättat fett.
- carbohydrate: kolhydrat totalt. sugars: varav sockerarter. polyols: varav polyoler.
- fibre: fiber eller kostfiber.
- protein: protein.
- salt: salt.
- alcohol: alkohol, bara om det står i deklarationen.
- servingSize: portionsstorleken om den står tryckt, med amount och unit ("g" eller "ml"). Annars null.

Regler:
- Läs kolumnen "per 100 g", eller "per 100 ml" för dryck.
- Varje siffra hör till raden den står på. Läs raden och siffran tillsammans. En rad som inte finns i deklarationen är null.
- Skriv av siffran exakt. Decimalkomma är en decimal: "5,6 g" är 5.6 och "56 g" är 56. Läs noga var kommat står.
- En siffra du inte kan läsa säkert är null. Gissa aldrig och räkna aldrig ut en siffra ur en annan.
- Bilden kan vara roterad, skrynklig eller suddig. Läs den ändå, och sätt null på det du inte kan läsa.
- Ser du ingen näringsdeklaration alls: null i alla fält och 0 i columns.`;

const figure = { type: ["number", "null"] };

/** The shape, enforced by Ollama while it samples (`format`). */
export const LABEL_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: ["string", "null"] },
    column: { type: ["string", "null"] },
    basis: { type: ["string", "null"], enum: ["100g", "100ml", null] },
    columns: { type: "integer" },
    energyKj: figure,
    energyKcal: figure,
    fat: figure,
    saturatedFat: figure,
    carbohydrate: figure,
    sugars: figure,
    polyols: figure,
    fibre: figure,
    protein: figure,
    salt: figure,
    alcohol: figure,
    servingSize: {
      type: ["object", "null"],
      properties: { amount: { type: "number" }, unit: { type: "string" } },
    },
  },
  required: [
    "name",
    "column",
    "basis",
    "columns",
    "energyKj",
    "energyKcal",
    "fat",
    "saturatedFat",
    "carbohydrate",
    "sugars",
    "polyols",
    "fibre",
    "protein",
    "salt",
    "alcohol",
    "servingSize",
  ],
};

export function readLabelMessages(image: string): ChatMessage[] {
  return [
    { role: "system", content: LABEL_SYSTEM_PROMPT },
    { role: "user", content: "Skriv av näringsdeklarationen på bilden.", images: [image] },
  ];
}

export type LabelReadOutcome =
  | { ok: true; label: LabelTranscription }
  | { ok: false; reason: "unusable_output"; detail: string };

/**
 * The model's answer, read strictly, with two repairs that change no figure.
 *
 * A serving size in a unit other than g or ml, or with no amount, is dropped
 * to null rather than failing the reply: it is optional, and the figures
 * beside it are the point. A figure the model wrote as a string with a
 * decimal comma, "5,6", is read as the number it spells, which is the same
 * reading a person makes. Anything else malformed refuses the whole reply,
 * because a figure that has to be guessed at is not a transcription.
 */
export function readLabel(content: string): LabelReadOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ok: false, reason: "unusable_output", detail: "not JSON" };
  }
  if (raw === null || typeof raw !== "object") {
    return { ok: false, reason: "unusable_output", detail: "not an object" };
  }

  const record = { ...(raw as Record<string, unknown>) };
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && /^\d+(?:[.,]\d+)?$/.test(value.trim()) && key !== "name" && key !== "column") {
      record[key] = Number(value.trim().replace(",", "."));
    }
  }
  const serving = record.servingSize as { amount?: unknown; unit?: unknown } | null | undefined;
  if (
    serving !== null &&
    (typeof serving !== "object" ||
      typeof serving.amount !== "number" ||
      !(serving.amount > 0) ||
      (serving.unit !== "g" && serving.unit !== "ml"))
  ) {
    record.servingSize = null;
  }

  const parsed = labelTranscriptionSchema.safeParse(record);
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
  return { ok: true, label: parsed.data };
}
