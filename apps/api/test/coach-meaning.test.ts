import { describe, expect, it } from "vitest";
import {
  GENERAL_MARKERS,
  INTERPRETATIONS,
  isMarkedGeneral,
  meaningFor,
  meaningLine,
  MEANING_PREFIX,
  type MeaningDomain,
  type MeaningState,
} from "../src/llm/coach-meaning.js";
import { checkSentence, type GuardVerdict } from "../src/llm/coach-guard.js";
import type { CoachFacts } from "../src/llm/coach-context.js";

/**
 * The interpretations the app writes, and the check that keeps the model from
 * writing its own (D171).
 *
 * D155 asked the coach, in the prompt, to say what each area means for the
 * goal. Across six live replies it did so once. This is the same requirement
 * moved out of the request and into the sheet, so the tests are about the
 * strings themselves: every one of them reviewable here, in one place.
 */

/** Enough of a sheet for the guard: it states no figures, so none are needed. */
const noFigures: CoachFacts = {
  text: "",
  figures: {
    kcal: [],
    kg: [],
    kgPerWeek: [],
    percent: [],
    grams: [],
    minutes: [],
    steps: [],
    hours: [],
    drinks: [],
    cm: [],
    count: [],
    ratio: [],
    scale: [],
  },
  guardrails: { intakeFloorKcal: 1200, maxRateKgWeek: 0.9 },
  chars: 0,
};

const everyLine: { domain: MeaningDomain; state: MeaningState; line: string }[] = Object.entries(
  INTERPRETATIONS,
).flatMap(([domain, lines]) =>
  Object.entries(lines).map(([state, line]) => ({
    domain: domain as MeaningDomain,
    state: state as MeaningState,
    line: line as string,
  })),
);

describe("every interpretation, in every state", () => {
  it("has more than a handful, so this is not testing an empty set", () => {
    expect(everyLine.length).toBeGreaterThan(20);
  });

  it("says out loud that it is general", () => {
    for (const { domain, state, line } of everyLine) {
      expect(isMarkedGeneral(line), `${domain}/${state}: ${line}`).toBe(true);
    }
  });

  /**
   * No digits. Figures reach the sheet through `num()`, which registers them as
   * quotable; one typed into a fixed string would be a number the coach may
   * repeat that belongs to nobody's data.
   */
  it("states no figure", () => {
    for (const { domain, state, line } of everyLine) {
      expect(line, `${domain}/${state}`).not.toMatch(/\d/);
    }
  });

  /** The guard runs on replies, and a reply repeating these has to pass it. */
  it("passes the reply guard, which a coach repeating it will be held to", () => {
    for (const { domain, state, line } of everyLine) {
      const verdict: GuardVerdict = checkSentence(line, noFigures);
      expect(verdict, `${domain}/${state}: ${line}`).toEqual({ ok: true });
    }
  });

  it("never tells anybody what they should have done", () => {
    for (const { domain, state, line } of everyLine) {
      expect(line.toLowerCase(), `${domain}/${state}`).not.toMatch(/\bdu (bör|ska|måste|borde)\b/);
    }
  });

  it("gives every domain a line for having nothing, since that is a state too", () => {
    for (const [domain, lines] of Object.entries(INTERPRETATIONS)) {
      expect(lines.none, `${domain} has no "none" line`).toBeTruthy();
    }
  });

  it("falls back to the domain's none line rather than to silence", () => {
    // `high` is not defined for sleep: the sheet cannot tell "too much sleep".
    expect(meaningLine("sleep", "high")).toBe(INTERPRETATIONS.sleep.none);
    expect(meaningFor("sleep", "none").startsWith(MEANING_PREFIX)).toBe(true);
  });
});

/**
 * The causal check, both directions (D171).
 *
 * The rule has been in the prompt since D155 and two live replies broke it
 * anyway. What makes it enforceable is that the app's own interpretations are
 * marked as general, so the marker can be the exemption: a sentence saying one
 * thing affects another passes only while it is saying so in general.
 */
describe("saying one thing affects another", () => {
  const refusal = (sentence: string) => checkSentence(sentence, noFigures);

  it("is refused when it is about this person's data", () => {
    for (const sentence of [
      "Du kan justera antalet glas om du vill se hur det påverkar din energi.",
      "Sömnen påverkar din vikt.",
      "Färre glas leder till bättre energi.",
      "Det påverkade veckans resultat.",
    ]) {
      expect(refusal(sentence), sentence).toEqual({
        ok: false,
        reason: "causal",
        detail: expect.any(String),
      });
    }
  });

  it("is allowed when the sentence says it is general", () => {
    for (const sentence of [
      "Protein hjälper i regel de flesta att behålla muskler när vikten går ner.",
      "Kort sömn påverkar i regel orken dagen efter.",
      "Mindre alkohol leder oftast till en jämnare vecka.",
    ]) {
      expect(refusal(sentence), sentence).toEqual({ ok: true });
    }
  });

  it("uses the same markers the sheet writes with", () => {
    for (const marker of GENERAL_MARKERS) {
      expect(isMarkedGeneral(`Det här är ${marker} sant.`)).toBe(true);
    }
    expect(isMarkedGeneral("Det här är alltid sant.")).toBe(false);
  });

  /** A sentence with neither the words nor a cause is left alone. */
  it("does not touch an ordinary sentence", () => {
    expect(refusal("Du har loggat mat sex dagar den här veckan.")).toEqual({ ok: true });
    expect(refusal("Sömnen och energin ligger bredvid varandra under Samband.")).toEqual({ ok: true });
  });
});
