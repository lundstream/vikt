import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auth, createUser, localDate, logWeight } from "./factories.js";
import { useTestApp } from "./harness.js";
import { coachMessages } from "../src/db/schema.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { checkReply, isMedicalQuestion, withQuestionFigures } from "../src/llm/coach-guard.js";
import type { CoachFacts } from "../src/llm/coach-context.js";

/**
 * The coach (D139), §6 phase 8b.
 *
 * The 8b entry is explicit about what a test can and cannot prove here: no test
 * shows that a model phrases something well. What these hold is the part that
 * is mechanical, and it is the part that matters — that a reply crossing a hard
 * limit is **refused rather than rendered**, that a figure the app never
 * produced cannot reach the screen, that a medical question is not passed on at
 * all, that the history is scoped and deletable, and that the whole surface
 * disappears with the flag off.
 *
 * Every clock and every date is supplied.
 */

/** A model that says whatever the test hands it, and records what it was asked. */
function stubLlm(reply: ChatResult, options: { reachable?: boolean } = {}) {
  const calls: { messages: { role: string; content: string }[] }[] = [];

  const client: LlmClient = {
    enabled: true,
    chat: async (chatOptions) => {
      calls.push({ messages: chatOptions.messages });
      return reply;
    },
    chatStream: async (chatOptions, onDelta) => {
      calls.push({ messages: chatOptions.messages });
      if (reply.ok) {
        // Delivered in pieces, because the sentence buffering is the thing
        // under test: a reply that arrives whole would never exercise it.
        for (const chunk of reply.content.match(/.{1,12}/gs) ?? []) onDelta(chunk);
      }
      return reply;
    },
    reachable: async () => options.reachable ?? true,
  };

  return { client, calls };
}

const says = (content: string): ChatResult => ({
  ok: true,
  content,
  model: "qwen3.6:27b",
  ms: 1200,
});

const offLlm: LlmClient = {
  enabled: false,
  chat: async () => ({ ok: false, reason: "disabled" }),
  chatStream: async () => ({ ok: false, reason: "disabled" }),
  reachable: async () => false,
};

/* ------------------------------------------------------------- the guard -- */

/** The facts a reply is checked against, with the two limits spelled out. */
const FACTS: CoachFacts = {
  text: "irrelevant here",
  figures: {
    kcal: [1500, 1800, 2450],
    kg: [84.2, 1.4],
    percent: [72, 86],
    kgPerWeek: [0.35, 0.84],
    // The data sheet's units (D155). Written out rather than spread from an
    // empty set, so a unit added without a thought about what a reply may
    // quote in it shows up here as a compiler error.
    grams: [118, 140],
    minutes: [145],
    steps: [8200],
    hours: [7.2],
    drinks: [4],
    cm: [92.4, 1.2],
    count: [3, 5, 7, 28],
    ratio: [],
    scale: [3.4],
  },
  guardrails: { intakeFloorKcal: 1500, maxRateKgWeek: 0.84 },
  chars: 42,
};

describe("what the coach may say", () => {
  it("lets through a reply whose figures are the app's own", () => {
    const verdict = checkReply(
      "Trendvikten ligger på 84,2 kg och du har ätit runt 1 800 kcal om dagen. Det ser stadigt ut.",
      FACTS,
    );
    expect(verdict.ok).toBe(true);
  });

  /**
   * Rule 2, the one an accommodating model breaks: asked "what if I ate 800",
   * it answers the question. The prompt says not to; this is what makes it so.
   */
  it("refuses an intake below the plan's floor", () => {
    const verdict = checkReply("Du kan sikta på 1 200 kcal om dagen ett tag.", FACTS);
    expect(verdict).toMatchObject({ ok: false, reason: "floor" });
  });

  it("refuses it as an example too, not only as advice", () => {
    const verdict = checkReply("Att äta 800 kcal skulle gå snabbare.", FACTS);
    expect(verdict).toMatchObject({ ok: false, reason: "floor" });
  });

  /**
   * And the narrowing that makes the rule usable: a **description** of a logged
   * day that happens to be under the floor is a true thing about the data, and
   * refusing it would leave the coach unable to talk about the week it was
   * given.
   */
  it("still lets it describe a day that was under the floor", () => {
    const verdict = checkReply(
      "På tisdagen blev det 1 450 kcal, vilket är lågt för dig.",
      { ...FACTS, figures: { ...FACTS.figures, kcal: [...FACTS.figures.kcal, 1450] } },
    );
    expect(verdict.ok).toBe(true);
  });

  it("refuses a rate above one percent of bodyweight a week", () => {
    const verdict = checkReply("Sikta på 1,5 kg i veckan så går det fort.", FACTS);
    expect(verdict).toMatchObject({ ok: false, reason: "rate" });
  });

  /**
   * Rule 1, which is also how D5 is enforced here: the calorie count of a food
   * is not a number this app handed the model, and never will be.
   */
  it("refuses a calorie figure for a food, because it is not in the data", () => {
    const verdict = checkReply("En banan är ungefär 105 kcal.", FACTS);
    expect(verdict).toMatchObject({ ok: false, reason: "untraceable" });
  });

  it("refuses any figure it was not given", () => {
    expect(checkReply("Din underhållsnivå är 3 100 kcal.", FACTS)).toMatchObject({
      ok: false,
      reason: "untraceable",
    });
  });

  it("allows honest rounding of a figure it was given", () => {
    expect(checkReply("Du ligger kring 1 810 kcal om dagen.", FACTS).ok).toBe(true);
  });

  /**
   * Found by a live run: the context said "0,32 kg i veckan" and the summary
   * wrote "sjönk med 0,32 kg", which was refused as invented. Kilograms are
   * kilograms; a true sentence being refused is the expensive kind of wrong,
   * because the reader sees the app distrusting itself.
   */
  it("does not refuse a weekly figure written without the week", () => {
    expect(checkReply("Vikten sjönk med 0,35 kg.", FACTS).ok).toBe(true);
  });

  /** And a calorie figure still cannot be vouched for by a weight. */
  it("keeps calories and kilograms apart", () => {
    expect(checkReply("Du åt 84 kcal.", FACTS)).toMatchObject({
      ok: false,
      reason: "untraceable",
    });
  });

  /**
   * Found live: the neutral tone answered "systemet genererar ingen plan
   * baserad på 800 kcal" and was refused for a figure the **person** had just
   * typed. Repeating somebody's own number is the opposite of inventing one.
   */
  it("lets the reply repeat a figure from the question", () => {
    const asked = withQuestionFigures(FACTS, "Vad händer om jag äter 800 kcal om dagen?");
    expect(checkReply("Systemet sätter ingen plan på 800 kcal.", asked).ok).toBe(true);
  });

  /** And that concession does not reopen the floor. */
  it("still refuses to recommend the figure the question named", () => {
    const asked = withQuestionFigures(FACTS, "Vad händer om jag äter 800 kcal om dagen?");
    expect(checkReply("Sikta på 800 kcal om dagen.", asked)).toMatchObject({
      ok: false,
      reason: "floor",
    });
  });

  /**
   * The absence rule (D140's addendum), in both directions.
   *
   * Every live run before it existed produced at least one sentence making the
   * person the subject of a missing figure, in at least one tone. The register
   * the app has used since Phase 2 puts the data there instead.
   */
  it("refuses a sentence about what somebody did not log", () => {
    for (const sentence of [
      "Du har vägt dig fyra gånger utan att logga något intag.",
      "Du har inte loggat någon mat den här veckan.",
      "Du loggade inget intag alls i tisdags.",
      "Du har glömt att fylla i dagen.",
      "Du borde ha loggat mer.",
    ]) {
      expect(checkReply(sentence, FACTS), sentence).toMatchObject({
        ok: false,
        reason: "blame",
      });
    }
  });

  it("allows the same fact with the data as the subject", () => {
    for (const sentence of [
      "Intaget är inte ifyllt än för den här veckan.",
      "Det finns ingen vikt för i går än.",
      "Underhållsnivån saknas, eftersom matdata inte räcker än.",
      "Det saknas matloggning för att räkna fram en underhållsnivå.",
    ]) {
      expect(checkReply(sentence, FACTS).ok, sentence).toBe(true);
    }
  });

  /**
   * The blame check reads one clause, not one sentence (D155).
   *
   * Found live, in the warm tone: "Du har loggat mat två dagar den här veckan,
   * med gryta och havregrynsgröt som exempel, medan rörelse och steg inte är
   * ifyllda än." The person, a logging verb and a negation were all in the
   * sentence, and none of them were in the same clause — the first half says
   * what was logged and the second says what the app does not have, with the
   * data as its subject, which is precisely what the rules ask for.
   */
  it("does not read a reproach across a comma", () => {
    const verdict = checkReply(
      "Du har loggat mat två dagar den här veckan, med gryta och havregrynsgröt " +
        "som exempel, medan rörelse och steg inte är ifyllda än.",
      FACTS,
    );

    expect(verdict.ok).toBe(true);
  });

  it("still refuses the reproach itself", () => {
    for (const sentence of [
      "Du har inte loggat något intag den här veckan.",
      "Du har aldrig fyllt i sömnen.",
      "Du har vägt dig fyra gånger utan att logga något intag.",
      "Du glömde bocka av vanorna i går.",
    ]) {
      const verdict = checkReply(sentence, FACTS);
      expect(verdict.ok, `let through: ${sentence}`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("blame");
    }
  });

  /**
   * The instruction rule (D155), both directions.
   *
   * The reason it is in code and not only in the prompt is the question that
   * produced it: "något jag bör tänka på?" hands the model the forbidden word,
   * and an accommodating model uses the words it was given. A suggestion is
   * still allowed, and that is the half this has to get right — a check that
   * refused "du kan" would leave the coach with nothing to offer at all.
   */
  it("refuses a suggestion phrased as an instruction", () => {
    for (const sentence of [
      "Du bör äta mer protein.",
      "Du måste sova mer.",
      "Du ska röra på dig oftare.",
      "Mer protein borde du prioritera.",
      "Man bör äta frukost.",
      "Se till att du kommer ut och går.",
    ]) {
      const verdict = checkReply(sentence, FACTS);
      expect(verdict.ok, `let through: ${sentence}`).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("instruction");
    }
  });

  it("lets the same suggestion through as an option", () => {
    for (const sentence of [
      "Du kan lägga till lite mer protein om du vill.",
      "Ett alternativ är att sova lite mer.",
      "Om du vill finns det utrymme för mer rörelse.",
      "Du skulle kunna ta en promenad på lunchen.",
      "Det ska bli intressant att se nästa vecka.",
      "Nästa vägning ska visa om det håller i sig.",
    ]) {
      const verdict = checkReply(sentence, FACTS);
      expect(verdict.ok, `refused: ${sentence}`).toBe(true);
    }
  });

  /** The one instruction the app does want, and built a whole path to produce. */
  it("still lets it send somebody to care", () => {
    const verdict = checkReply("Det där bör du ta med vården.", FACTS);
    expect(verdict.ok).toBe(true);
  });

  /** The floor and the rate are unchanged by any of this. */
  it("keeps the floor and the rate checks exactly as they were", () => {
    const floor = checkReply("Sikta på 1 200 kcal om dagen.", FACTS);
    expect(floor.ok).toBe(false);
    if (!floor.ok) expect(floor.reason).toBe("floor");

    const rate = checkReply("Försök gå ner 1,5 kg i veckan.", FACTS);
    expect(rate.ok).toBe(false);
    if (!rate.ok) expect(rate.reason).toBe("rate");
  });

  /** The units the data sheet added, each vouching only for itself (D155). */
  it("traces the data sheet's own units", () => {
    expect(checkReply("Proteinet ligger på 118 g per dag.", FACTS).ok).toBe(true);
    expect(checkReply("Det blev 145 minuter rörelse.", FACTS).ok).toBe(true);
    expect(checkReply("Runt 8 200 steg per dag.", FACTS).ok).toBe(true);
    expect(checkReply("Sömnen ligger på 7,2 timmar.", FACTS).ok).toBe(true);
    expect(checkReply("Midjan är 92,4 cm.", FACTS).ok).toBe(true);
    expect(checkReply("Det blev 4 standardglas.", FACTS).ok).toBe(true);
    expect(checkReply("Tre pass på 7 dagar.", FACTS).ok).toBe(true);
  });

  it("refuses a figure in one of those units that it was not given", () => {
    const verdict = checkReply("Proteinet ligger på 210 g per dag.", FACTS);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("untraceable");
  });

  /** A gram is not a kilo and a step is not a minute. */
  it("does not let one new unit vouch for another", () => {
    // 145 is a real figure in the sheet, in minutes.
    const verdict = checkReply("Du har gått 145 steg.", FACTS);
    expect(verdict.ok).toBe(false);
  });

  /** "140 grader" is not "140 g". */
  it("does not read a unit out of the middle of a word", () => {
    expect(checkReply("Ugnen stod på 210 grader.", FACTS).ok).toBe(true);
  });

  it("knows a medical question when it sees one", () => {
    expect(isMedicalQuestion("Kan min sköldkörtel förklara det här?")).toBe(true);
    expect(isMedicalQuestion("Ska jag byta medicin?")).toBe(true);
    expect(isMedicalQuestion("Hur ligger jag till den här veckan?")).toBe(false);
  });
});

/* ------------------------------------------------------------- the turn -- */

/** Reads an SSE body into the events it carried. */
function eventsOf(body: string): { type: string; [key: string]: unknown }[] {
  return body
    .split("\n\n")
    .map((block) => block.replace(/^data:\s*/, "").trim())
    .filter((block) => block !== "")
    .map((block) => JSON.parse(block) as { type: string });
}

describe("a turn", () => {
  const stub = stubLlm(says("Det ser stadigt ut. Trendvikten ligger på 84,2 kg."));
  const ctx = useTestApp({}, { llm: stub.client });

  async function ask(question: string, conversationId: string | null = null) {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 84.2);

    const response = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question, conversationId, asOf: localDate(0) },
    });

    return { user, response, events: eventsOf(response.body) };
  }

  it("streams sentences and stores the answer", async () => {
    const { user, response, events } = await ask("Hur ligger jag till?");
    const { db } = ctx();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(events.filter((event) => event.type === "sentence").length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe("done");

    const stored = await db.select().from(coachMessages).where(eq(coachMessages.userId, user.userId));
    expect(stored.map((row) => row.role)).toEqual(["user", "coach"]);
    expect(stored[1]?.refusal).toBeNull();
    // The size of the context is recorded, because it has to fit num_ctx.
    expect(stored[1]?.contextChars).toBeGreaterThan(0);
  });

  it("sends the aggregates and no rows", async () => {
    await ask("Hur ligger jag till?");

    const system = stub.calls.at(-1)?.messages[0]?.content ?? "";
    expect(system).toContain("Trendvikt");
    expect(system).toContain("Spärrar appen räknar med");
    // Nothing that could only come from a row.
    expect(system).not.toContain("client_uuid");
    expect(system).not.toContain("logged_at");
  });
});

describe("a turn that breaks a rule", () => {
  const stub = stubLlm(says("Sikta på 900 kcal om dagen, det går fortare."));
  const ctx = useTestApp({}, { llm: stub.client });

  it("is refused rather than rendered, and the text is not kept", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 84.2);

    const response = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Vad händer om jag äter jättelite?", asOf: localDate(0) },
    });

    const events = eventsOf(response.body);
    const refusal = events.find((event) => event.type === "refused");

    expect(refusal).toBeDefined();
    expect(events.some((event) => event.type === "sentence")).toBe(false);
    expect(String(refusal?.message)).toContain("golvet");

    const stored = await db.select().from(coachMessages).where(eq(coachMessages.userId, user.userId));
    const coach = stored.find((row) => row.role === "coach");
    expect(coach?.refusal).toBe("floor");
    // The sentence that caused it is not in the history.
    expect(coach?.body).not.toContain("900");
  });
});

describe("a medical question", () => {
  const stub = stubLlm(says("Det ser stadigt ut."));
  const ctx = useTestApp({}, { llm: stub.client });

  it("is answered by the app and never reaches the model", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const before = stub.calls.length;

    const response = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: {
        question: "Kan min sköldkörtel vara anledningen till att det står still?",
        asOf: localDate(0),
      },
    });

    const events = eventsOf(response.body);
    const sentence = events.find((event) => event.type === "sentence");

    expect(String(sentence?.text)).toContain("medicinsk fråga");
    // One plain sentence, not a paragraph of disclaimer.
    expect(String(sentence?.text).length).toBeLessThan(220);
    expect(stub.calls.length).toBe(before);
  });
});

/* ----------------------------------------------------------- the history -- */

describe("the history", () => {
  const stub = stubLlm(says("Det ser stadigt ut."));
  const ctx = useTestApp({}, { llm: stub.client });

  async function conversationFor(user: Awaited<ReturnType<typeof createUser>>) {
    const { app } = ctx();
    await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Hur går det?", asOf: localDate(0) },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/coach/conversations",
      headers: auth(user),
    });
    return list.json<{ conversations: { id: string; title: string }[] }>().conversations;
  }

  it("is listed, readable and named after the first question", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const conversations = await conversationFor(user);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.title).toBe("Hur går det?");

    const one = await app.inject({
      method: "GET",
      url: `/api/coach/conversations/${conversations[0]!.id}`,
      headers: auth(user),
    });
    expect(one.json<{ messages: unknown[] }>().messages).toHaveLength(2);
  });

  it("belongs to one account", async () => {
    const { app, db } = ctx();
    const mine = await createUser(app, db);
    const theirs = await createUser(app, db);

    const conversations = await conversationFor(theirs);

    const peek = await app.inject({
      method: "GET",
      url: `/api/coach/conversations/${conversations[0]!.id}`,
      headers: auth(mine),
    });
    expect(peek.statusCode).toBe(404);

    const remove = await app.inject({
      method: "DELETE",
      url: `/api/coach/conversations/${conversations[0]!.id}`,
      headers: auth(mine),
    });
    expect(remove.statusCode).toBe(404);
  });

  it("is deletable one conversation at a time", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    const conversations = await conversationFor(user);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/coach/conversations/${conversations[0]!.id}`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(204);

    const after = await db.select().from(coachMessages).where(eq(coachMessages.userId, user.userId));
    expect(after).toEqual([]);
  });

  it("is deletable in full", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await conversationFor(user);
    await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Och nu då?", asOf: localDate(0) },
    });

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/coach/conversations",
      headers: auth(user),
    });

    expect(removed.json<{ removed: number }>().removed).toBe(2);
    expect(
      await db.select().from(coachMessages).where(eq(coachMessages.userId, user.userId)),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------- the flag -- */

describe("with the LLM layer off", () => {
  const ctx = useTestApp({}, { llm: offLlm });

  /**
   * Absent, not disabled (D94). A 404 from a path that does not exist is the
   * same answer this app gives for every other unavailable feature.
   */
  it("has no coach at all", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    for (const url of ["/api/coach/conversations", "/api/coach/reviews"]) {
      const response = await app.inject({ method: "GET", url, headers: auth(user) });
      expect(response.statusCode, url).toBe(404);
    }

    const ask = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Hej?", asOf: localDate(0) },
    });
    expect(ask.statusCode).toBe(404);
  });
});

describe("when the workstation is off", () => {
  const stub = stubLlm(says("aldrig"), { reachable: false });
  const ctx = useTestApp({}, { llm: stub.client });

  /** Chat is not queued for later: an answer to an hour-old question is noise. */
  it("says so and stores nothing", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Hur går det?", asOf: localDate(0) },
    });

    expect(eventsOf(response.body).at(-1)?.type).toBe("unreachable");
    expect(
      await db.select().from(coachMessages).where(eq(coachMessages.userId, user.userId)),
    ).toEqual([]);
  });
});
