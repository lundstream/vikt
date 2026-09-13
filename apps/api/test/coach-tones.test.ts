import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { COACH_TONES, type CoachTone } from "shared";
import { auth, createUser, localDate, logWeight } from "./factories.js";
import { useTestApp } from "./harness.js";
import { profiles } from "../src/db/schema.js";
import type { ChatResult, LlmClient } from "../src/llm/client.js";
import { APP_FACTS, buildCoachPrompt, COACH_RULES, TONE_BLOCKS } from "../src/llm/prompts/coach.js";

/**
 * The three tones (D140).
 *
 * Two things are worth holding here. The first is structural: a tone may change
 * how the coach sounds and **nothing else**, so every assembled prompt has to
 * carry the shared rules verbatim. The second is that the pipeline does not
 * care which tone is in force — the guardrail, the medical deferral and the
 * storage behave identically, because a warmer prompt is exactly the condition
 * under which somebody would hope the limits had loosened.
 *
 * What no test here can show is whether a warmer prompt makes the **model**
 * cross a line more often. That is a question about a model, and it is answered
 * by running the live battery per tone and writing down what came back, which
 * D140 does.
 */

describe("the prompt", () => {
  it("carries the shared rules verbatim, in every tone", () => {
    for (const tone of COACH_TONES) {
      const prompt = buildCoachPrompt(tone, "Trendvikt nu: 84,2 kg.");
      expect(prompt, tone).toContain(COACH_RULES);
    }
  });

  it("carries the fact sheet in every tone", () => {
    for (const tone of COACH_TONES) {
      expect(buildCoachPrompt(tone, "x"), tone).toContain(APP_FACTS);
    }
  });

  /**
   * The absence rule travels with the rest, in every tone (D140's addendum).
   *
   * It is in `COACH_RULES` rather than in the tone blocks precisely because a
   * warmer voice is the one most likely to reach for "du har inte loggat" as a
   * kindness.
   */
  it("carries the absent-data rule in every tone", () => {
    expect(COACH_RULES).toMatch(/inte är ifylld än/);
    expect(COACH_RULES).toMatch(/glömt/);

    for (const tone of COACH_TONES) {
      expect(buildCoachPrompt(tone, "x"), tone).toMatch(/inte är ifylld än/);
    }
  });

  /** The fact sheet exists to answer the false claim a live run produced. */
  it("says that no day is invalid, which is what the model got wrong", () => {
    expect(APP_FACTS).toMatch(/Ingen dag är ogiltig/);
    expect(APP_FACTS).toMatch(/uppskattning/);
    expect(APP_FACTS).toMatch(/Du kan inte logga/);
  });

  it("gives each tone its own words", () => {
    const blocks = COACH_TONES.map((tone) => TONE_BLOCKS[tone]);
    expect(new Set(blocks).size).toBe(COACH_TONES.length);
    // The one without a persona says so rather than inventing a quieter one.
    expect(TONE_BLOCKS.saklig).toMatch(/ingen personlighet/);
  });

  it("puts the numbers last, where the model has just been told the rules", () => {
    const prompt = buildCoachPrompt("torr", "MARKER-FACTS");
    expect(prompt.indexOf(COACH_RULES)).toBeLessThan(prompt.indexOf("MARKER-FACTS"));
  });
});

/* ------------------------------------------------- the pipeline, per tone -- */

function stubLlm(reply: ChatResult) {
  const calls: { messages: { role: string; content: string }[] }[] = [];
  const client: LlmClient = {
    enabled: true,
    chat: async (options) => {
      calls.push({ messages: options.messages });
      return reply;
    },
    chatStream: async (options, onDelta) => {
      calls.push({ messages: options.messages });
      if (reply.ok) onDelta(reply.content);
      return reply;
    },
    reachable: async () => true,
  };
  return { client, calls };
}

const says = (content: string): ChatResult => ({
  ok: true,
  content,
  model: "qwen3.6:27b",
  ms: 900,
});

function eventsOf(body: string): { type: string; [key: string]: unknown }[] {
  return body
    .split("\n\n")
    .map((block) => block.replace(/^data:\s*/, "").trim())
    .filter((block) => block !== "")
    .map((block) => JSON.parse(block) as { type: string });
}

/**
 * The guardrail battery from D139, once per tone.
 *
 * The model is stubbed with a reply that breaks the rule, which is the only way
 * to test the **app's** behaviour: a live model may or may not break it on any
 * given roll, and what is being asserted here is that the refusal does not
 * depend on which voice was chosen.
 */
describe.each(COACH_TONES)("with the %s tone", (tone: CoachTone) => {
  const breaking = stubLlm(says("Sikta på 900 kcal om dagen, det går fortare."));
  const ctx = useTestApp({}, { llm: breaking.client });

  async function accountWith(toneChoice: CoachTone) {
    const { app, db } = ctx();
    const user = await createUser(app, db);
    await logWeight(app, user, 84.2);
    await db.update(profiles).set({ coachTone: toneChoice }).where(eq(profiles.userId, user.userId));
    return user;
  }

  it("sends this tone's block and the shared rules", async () => {
    const { app } = ctx();
    const user = await accountWith(tone);

    await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Hur går det?", asOf: localDate(0) },
    });

    const system = breaking.calls.at(-1)?.messages[0]?.content ?? "";
    expect(system).toContain(TONE_BLOCKS[tone]);
    expect(system).toContain(COACH_RULES);
  });

  it("refuses an intake under the floor", async () => {
    const { app } = ctx();
    const user = await accountWith(tone);

    const response = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Vad händer om jag äter jättelite?", asOf: localDate(0) },
    });

    const events = eventsOf(response.body);
    expect(events.find((event) => event.type === "refused"), tone).toMatchObject({
      reason: "floor",
    });
    expect(events.some((event) => event.type === "sentence")).toBe(false);
  });

  it("defers a medical question without calling the model", async () => {
    const { app } = ctx();
    const user = await accountWith(tone);
    const before = breaking.calls.length;

    const response = await app.inject({
      method: "POST",
      url: "/api/coach/ask",
      headers: auth(user),
      payload: { question: "Kan min sköldkörtel förklara det?", asOf: localDate(0) },
    });

    expect(breaking.calls.length, tone).toBe(before);
    expect(String(eventsOf(response.body)[0]?.text)).toContain("medicinsk fråga");
  });
});

describe("the tone itself", () => {
  const stub = stubLlm(says("Det ser stadigt ut."));
  const ctx = useTestApp({}, { llm: stub.client });

  it("defaults to the voice that already existed", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.userId));
    expect(profile?.coachTone).toBe("torr");
  });

  it("is saved on the profile and comes back with the identity", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { coachTone: "saklig" },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: auth(user) });
    expect(me.json<{ profile: { coachTone: string } }>().profile.coachTone).toBe("saklig");
  });

  /** A closed set: anything else is refused rather than stored and guessed at. */
  it("refuses a tone that does not exist", async () => {
    const { app, db } = ctx();
    const user = await createUser(app, db);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/me/profile",
      headers: auth(user),
      payload: { coachTone: "hård" },
    });

    expect(response.statusCode).toBe(400);
  });
});
