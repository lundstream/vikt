import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { Env } from "../env.js";
import type { LlmClient } from "../llm/client.js";
import { coachToneSchema, type CoachTone } from "shared";
import { coachConversations, coachMessages, profiles, weeklyReviews } from "../db/schema.js";
import { buildCoachPrompt, COACH_NAME } from "../llm/prompts/coach.js";
import {
  buildCoachFacts,
  CONTEXT_TURNS,
  type CoachFacts,
} from "../llm/coach-context.js";
import {
  checkSentence,
  isMedicalQuestion,
  sentencesOf,
  withQuestionFigures,
} from "../llm/coach-guard.js";
import { RateLimiter } from "../lib/rate-limit.js";

/**
 * The coach chat (D139), §6 phase 8b.
 *
 * The rules this file exists to hold, in the order they bite:
 *
 * **It reads and never writes.** There is no path from a conversation to a row
 * in any other table. The coach cannot log food, change a plan, tick a habit or
 * set a reminder; it can say where a screen is, and the screen is where the
 * person does it. That is not a limitation to work around later: a model that
 * can write is a model whose mistakes are stored.
 *
 * **A medical question never reaches the model.** Detected here, answered with
 * the app's own sentence. A deferral has to be reliable, and a model's
 * willingness to decline is not.
 *
 * **Every reply is checked as it streams**, sentence by sentence, against the
 * figures the context actually contained. A sentence that fails is never sent
 * to the screen and never stored; what is stored is the refusal.
 *
 * **One turn at a time per user, and a short queue across users.** The
 * workstation has one GPU and every account shares it. Two turns in parallel
 * are not twice as fast, they are twice as slow each, and the honest thing to
 * show the second person is that the coach is busy.
 */

/** Per account per hour. Generous for a conversation, bounded for a queue. */
export const COACH_TURNS_PER_HOUR = 20;

const turnLimiter = new RateLimiter(COACH_TURNS_PER_HOUR, 60 * 60_000);

/**
 * How many turns may wait for the model at once, across every account.
 *
 * Small on purpose. A deep queue turns "busy" into "eight minutes from now",
 * which is worse than being told to come back: chat is the one surface in this
 * app where an answer that arrives late has no value, and D6 says this layer
 * degrades rather than defers.
 */
export const COACH_QUEUE_DEPTH = 3;

/** The shared lane. In memory, single instance, like the mail drainer (D104). */
const inFlight = new Set<string>();
let queued = 0;

export type CoachEvent =
  | { type: "sentence"; text: string }
  | { type: "done"; messageId: string; body: string }
  | { type: "refused"; reason: string; message: string }
  | { type: "busy" }
  | { type: "unreachable" }
  | { type: "limited"; retryAfterSeconds: number };

export type AskInput = {
  conversationId: string | null;
  question: string;
  asOf: string;
};

/**
 * What the app says when it will not pass a question on.
 *
 * One sentence, in the coach's register, and it names where the answer belongs
 * instead. §6 phase 8b asks for exactly that and explicitly not for a paragraph
 * of disclaimer.
 */
export const MEDICAL_DEFERRAL =
  "Det där är en medicinsk fråga, och den ska du ta med vården i stället för med mig. " +
  "Jag håller mig till det appen har mätt.";

/** What the reader is told when the post-check refuses a reply. */
export function refusalMessage(reason: string, facts: CoachFacts): string {
  switch (reason) {
    case "floor":
      return (
        `Jag får inte föreslå ett intag under ${facts.guardrails.intakeFloorKcal} kcal per dag. ` +
        "Det är golvet i din plan, och det finns för att ett lägre intag inte går att få i sig " +
        "tillräckligt med näring på. Vill du ändra planen gör du det under Plan."
      );
    case "rate":
      return (
        "Jag får inte föreslå en snabbare takt än 1 procent av kroppsvikten i veckan. " +
        "Appen räknar fram takten själv utifrån din plan, och den spärren sitter i planen."
      );
    case "blame":
      return (
        "Jag höll på att skriva om vad du inte har gjort i stället för om vad appen inte har, " +
        "så jag svarar inte alls. Det som saknas är uppgifter som inte är ifyllda än, " +
        "och du fyller i dem där de hör hemma."
      );
    case "instruction":
      return (
        "Jag höll på att tala om för dig vad du ska göra, och det är inte min roll. " +
        "Jag kan peka på vad siffrorna visar och på sin höjd föreslå en riktning, " +
        "men vad du gör med den är ditt val."
      );
    case "untraceable":
      return (
        "Jag höll på att svara med en siffra som inte kommer ur dina egna uppgifter, så jag " +
        `svarar inte alls. Vill du ha kalorier eller makron för en maträtt finns de under Mat, ` +
        "där de kommer från databasen."
      );
    default:
      return "Jag fick inget vettigt svar den här gången. Fråga gärna igen.";
  }
}

/**
 * The chosen tone, the unchanging rules, the fact sheet and the numbers.
 *
 * Assembled in `prompts/coach.ts` (D140), which is still the only file that
 * says anything at all about how the coach sounds.
 */
function systemPrompt(tone: CoachTone, facts: CoachFacts): string {
  return buildCoachPrompt(tone, facts.text);
}

async function loadTurns(userId: string, db: Db, conversationId: string) {
  const rows = await db
    .select()
    .from(coachMessages)
    .where(
      and(eq(coachMessages.userId, userId), eq(coachMessages.conversationId, conversationId)),
    )
    .orderBy(desc(coachMessages.createdAt))
    .limit(CONTEXT_TURNS * 2);

  return rows.reverse();
}

async function ensureConversation(
  userId: string,
  db: Db,
  conversationId: string | null,
  question: string,
): Promise<string | null> {
  if (conversationId !== null) {
    const [existing] = await db
      .select({ id: coachConversations.id })
      .from(coachConversations)
      .where(
        and(eq(coachConversations.userId, userId), eq(coachConversations.id, conversationId)),
      )
      .limit(1);
    return existing?.id ?? null;
  }

  const [created] = await db
    .insert(coachConversations)
    .values({ userId, title: question.slice(0, 80) })
    .returning({ id: coachConversations.id });

  return created!.id;
}

/**
 * One turn, streamed.
 *
 * Everything is yielded as an event rather than returned, because the caller is
 * an SSE handler and the whole point is that the first sentence reaches the
 * screen before the last one exists.
 */
export async function* askCoach(
  userId: string,
  db: Db,
  env: Env,
  llm: LlmClient,
  input: AskInput,
): AsyncGenerator<CoachEvent> {
  const limit = turnLimiter.check(`coach:${userId}`);
  if (!limit.allowed) {
    yield { type: "limited", retryAfterSeconds: limit.retryAfterSeconds };
    return;
  }

  /**
   * Reachability first, and nothing is stored if the answer is no.
   *
   * §6 phase 8b's operations rule says chat is **not** queued for later: an
   * answer to a question somebody asked an hour ago, about numbers that have
   * since moved, is not worth the row it would be stored in.
   */
  if (!llm.enabled || !(await llm.reachable())) {
    yield { type: "unreachable" };
    return;
  }

  if (inFlight.has(userId) || queued >= COACH_QUEUE_DEPTH) {
    yield { type: "busy" };
    return;
  }

  const conversationId = await ensureConversation(userId, db, input.conversationId, input.question);
  if (conversationId === null) {
    yield { type: "refused", reason: "not_found", message: "Det samtalet finns inte." };
    return;
  }

  await db.insert(coachMessages).values({
    userId,
    conversationId,
    role: "user",
    body: input.question,
  });

  /* --------------------------------------------------- the medical deferral */

  if (isMedicalQuestion(input.question)) {
    const [stored] = await db
      .insert(coachMessages)
      .values({
        userId,
        conversationId,
        role: "coach",
        body: MEDICAL_DEFERRAL,
        refusal: "medical",
      })
      .returning({ id: coachMessages.id });

    await touch(userId, db, conversationId);
    yield { type: "sentence", text: MEDICAL_DEFERRAL };
    yield { type: "done", messageId: stored!.id, body: MEDICAL_DEFERRAL };
    return;
  }

  /**
   * The figures the question itself carried count as traceable (D140):
   * repeating somebody's own number back to them is not inventing one, and
   * the floor and rate checks are unaffected either way.
   */
  const facts = withQuestionFigures(
    await buildCoachFacts(userId, db, env, input.asOf),
    input.question,
  );
  const [history, tone] = await Promise.all([
    loadTurns(userId, db, conversationId),
    coachToneFor(userId, db),
  ]);

  const messages = [
    { role: "system" as const, content: systemPrompt(tone, facts) },
    ...history
      .filter((row) => row.refusal === null || row.role === "user")
      .slice(-(CONTEXT_TURNS * 2))
      .map((row) => ({
        role: row.role === "user" ? ("user" as const) : ("assistant" as const),
        content: row.body,
      })),
  ];

  queued += 1;
  inFlight.add(userId);

  try {
    /**
     * Sentences are released only once they have passed the check.
     *
     * The alternative — stream straight through and refuse afterwards — would
     * put the figure the check exists to stop in front of the reader and then
     * take it away, which is worse than not streaming at all.
     */
    let buffer = "";
    let released = "";
    let refusal: string | null = null;

    /**
     * The bridge between a callback and a generator.
     *
     * `chatStream` hands each chunk to a function; this loop has to `yield`.
     * Pushing into an array and draining it after the call would have made the
     * whole thing non-streaming while looking streamed, which is the bug this
     * shape exists to avoid: the sentences must leave here as they pass.
     */
    const ready: CoachEvent[] = [];
    let wake: (() => void) | null = null;
    const push = (event: CoachEvent) => {
      ready.push(event);
      const resume = wake;
      wake = null;
      resume?.();
    };

    let finished = false;
    const streaming = llm
      .chatStream(
        {
          model: env.OLLAMA_MODEL_LARGE,
          messages,
          timeoutMs: env.OLLAMA_JOB_TIMEOUT_MS,
          /**
           * Some variety. This is the one surface where the same words for a
           * slightly different question would read as a form letter, and it is
           * also the one surface where no number is trusted on the way out.
           */
          temperature: 0.6,
        },
        (delta) => {
          if (refusal !== null) return;
          buffer += delta;

          /**
           * Sentences are released only once they have passed the check.
           *
           * Streaming straight through and refusing afterwards would put the
           * figure the check exists to stop in front of the reader and then
           * take it away, which is worse than not streaming at all.
           */
          for (;;) {
            const sentences = sentencesOf(buffer);
            // The last one may still be growing, so it stays in the buffer.
            if (sentences.length < 2) break;

            const sentence = sentences.shift()!;
            const verdict = checkSentence(sentence, facts);
            if (!verdict.ok) {
              refusal = verdict.reason;
              return;
            }

            released += (released === "" ? "" : " ") + sentence;
            buffer = sentences.join(" ");
            push({ type: "sentence", text: sentence });
          }
        },
      )
      .then((value) => {
        finished = true;
        const resume = wake;
        wake = null;
        resume?.();
        return value;
      });

    while (!finished || ready.length > 0) {
      if (ready.length > 0) {
        yield ready.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    const result = await streaming;

    if (refusal === null && result.ok) {
      // Whatever is left in the buffer is the last sentence.
      for (const sentence of sentencesOf(buffer)) {
        const verdict = checkSentence(sentence, facts);
        if (!verdict.ok) {
          refusal = verdict.reason;
          break;
        }
        released += (released === "" ? "" : " ") + sentence;
        yield { type: "sentence", text: sentence };
      }
    }

    if (!result.ok) {
      yield { type: "unreachable" };
      return;
    }

    if (refusal !== null) {
      const message = refusalMessage(refusal, facts);
      await db.insert(coachMessages).values({
        userId,
        conversationId,
        role: "coach",
        body: message,
        refusal,
        contextChars: facts.chars,
        replyChars: result.content.length,
        model: result.model,
      });
      await touch(userId, db, conversationId);
      yield { type: "refused", reason: refusal, message };
      return;
    }

    const body = released.trim();
    const [stored] = await db
      .insert(coachMessages)
      .values({
        userId,
        conversationId,
        role: "coach",
        body,
        model: result.model,
        contextChars: facts.chars,
        replyChars: body.length,
      })
      .returning({ id: coachMessages.id });

    await touch(userId, db, conversationId);
    yield { type: "done", messageId: stored!.id, body };
  } finally {
    inFlight.delete(userId);
    queued -= 1;
  }
}

/** Which voice this account has chosen, falling back to the original one. */
export async function coachToneFor(userId: string, db: Db): Promise<CoachTone> {
  const [row] = await db
    .select({ tone: profiles.coachTone })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  return coachToneSchema.catch("torr").parse(row?.tone);
}

async function touch(userId: string, db: Db, conversationId: string): Promise<void> {
  await db
    .update(coachConversations)
    .set({ lastMessageAt: new Date() })
    .where(and(eq(coachConversations.userId, userId), eq(coachConversations.id, conversationId)));
}

/* ------------------------------------------------------------- the history */

export async function listConversations(userId: string, db: Db) {
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(coachConversations)
      .where(eq(coachConversations.userId, userId))
      .orderBy(desc(coachConversations.lastMessageAt)),
    /**
     * Counted in its own grouped query rather than as a correlated subquery.
     *
     * The subquery version reported **zero for every conversation**, found by
     * looking at the screen: written against Drizzle's table objects inside a
     * `sql` template it renders the table name with no alias for the outer row
     * to correlate against, so it counted nothing and said so quietly. Two
     * queries and a map are correct, and they are also easier to read than the
     * alias that would have fixed it.
     */
    db
      .select({
        conversationId: coachMessages.conversationId,
        count: sql<number>`count(*)::int`,
      })
      .from(coachMessages)
      .where(eq(coachMessages.userId, userId))
      .groupBy(coachMessages.conversationId),
  ]);

  const byConversation = new Map(counts.map((row) => [row.conversationId, row.count]));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    messages: byConversation.get(row.id) ?? 0,
  }));
}

export async function getConversation(userId: string, db: Db, id: string) {
  const [conversation] = await db
    .select()
    .from(coachConversations)
    .where(and(eq(coachConversations.userId, userId), eq(coachConversations.id, id)))
    .limit(1);

  if (!conversation) return null;

  const rows = await db
    .select()
    .from(coachMessages)
    .where(and(eq(coachMessages.userId, userId), eq(coachMessages.conversationId, id)))
    .orderBy(asc(coachMessages.createdAt));

  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    messages: rows.map((row) => ({
      id: row.id,
      role: row.role,
      body: row.body,
      refusal: row.refusal,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** One conversation, gone. The messages go with it, by cascade. */
export async function removeConversation(userId: string, db: Db, id: string): Promise<boolean> {
  const removed = await db
    .delete(coachConversations)
    .where(and(eq(coachConversations.userId, userId), eq(coachConversations.id, id)))
    .returning({ id: coachConversations.id });

  return removed.length > 0;
}

/** All of it. Offered next to the per-conversation delete, per §6 phase 8b. */
export async function removeAllConversations(userId: string, db: Db): Promise<number> {
  const removed = await db
    .delete(coachConversations)
    .where(eq(coachConversations.userId, userId))
    .returning({ id: coachConversations.id });

  return removed.length;
}

/* ------------------------------------------------------- the weekly review */

export async function listReviews(userId: string, db: Db) {
  const rows = await db
    .select()
    .from(weeklyReviews)
    .where(eq(weeklyReviews.userId, userId))
    .orderBy(desc(weeklyReviews.weekStart))
    .limit(12);

  return rows.map((row) => ({
    id: row.id,
    weekStart: row.weekStart,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    dismissed: row.dismissedAt !== null,
  }));
}

/** The newest review, if it has not been put away yet. Drives the card. */
export async function newestUndismissedReview(userId: string, db: Db) {
  const [row] = await db
    .select()
    .from(weeklyReviews)
    .where(and(eq(weeklyReviews.userId, userId), sql`${weeklyReviews.dismissedAt} is null`))
    .orderBy(desc(weeklyReviews.weekStart))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    weekStart: row.weekStart,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function dismissReview(userId: string, db: Db, id: string): Promise<boolean> {
  const updated = await db
    .update(weeklyReviews)
    .set({ dismissedAt: new Date() })
    .where(and(eq(weeklyReviews.userId, userId), eq(weeklyReviews.id, id)))
    .returning({ id: weeklyReviews.id });

  return updated.length > 0;
}

export { COACH_NAME };
