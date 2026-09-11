import { z } from "zod";
import { localDateSchema } from "./log.js";

/**
 * The three tones (D140).
 *
 * A closed set, in `shared` because the server picks a prompt with it and the
 * settings control offers exactly these three. Strict, roasting and
 * guilt-based tones are ruled out by §3 and by the Phase 8 entry, not by
 * taste, and adding a fourth means amending both documents.
 */
export const COACH_TONES = ["torr", "peppig", "saklig"] as const;
export type CoachTone = (typeof COACH_TONES)[number];
export const coachToneSchema = z.enum(COACH_TONES);


/**
 * The coach over the wire (D139), §6 phase 8b.
 *
 * The turn itself is **not** a JSON response: it is Server-Sent Events, one
 * object per line, and the event union is declared here so the client and the
 * server agree about what can arrive and in what order.
 */

/** The longest question the box accepts. A question, not an essay. */
export const COACH_QUESTION_MAX = 500;

export const coachAskSchema = z.object({
  /** Null starts a new conversation, named after the question. */
  conversationId: z.string().uuid().nullish(),
  question: z.string().trim().min(1).max(COACH_QUESTION_MAX),
  /** The client's own day, as everywhere else (§3). The server derives none. */
  asOf: localDateSchema,
});
export type CoachAsk = z.infer<typeof coachAskSchema>;

export const coachMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "coach"]),
  body: z.string(),
  /**
   * Why this reply was refused, when it was. Kept in the history so a refusal
   * is visible afterwards as what it was, rather than as the coach saying
   * something odd for no reason.
   */
  refusal: z.string().nullable(),
  createdAt: z.string(),
});
export type CoachMessage = z.infer<typeof coachMessageSchema>;

export const coachConversationSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
  lastMessageAt: z.string(),
  messages: z.array(coachMessageSchema),
});
export type CoachConversation = z.infer<typeof coachConversationSchema>;

export const coachConversationListSchema = z.object({
  conversations: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      createdAt: z.string(),
      lastMessageAt: z.string(),
      messages: z.number().int().min(0),
    }),
  ),
});
export type CoachConversationList = z.infer<typeof coachConversationListSchema>;

export const coachReviewSchema = z.object({
  id: z.string().uuid(),
  weekStart: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type CoachReview = z.infer<typeof coachReviewSchema>;

export const coachReviewListSchema = z.object({
  reviews: z.array(coachReviewSchema.extend({ dismissed: z.boolean() })),
});
export type CoachReviewList = z.infer<typeof coachReviewListSchema>;

/**
 * What arrives on the stream.
 *
 * `sentence` is text that has **already passed** the guardrail check, which is
 * why it is a sentence rather than a token: nothing reaches the screen that
 * would have to be taken back.
 *
 * The stream always ends with exactly one of the other five, so a client never
 * has to decide what a silence meant.
 */
export const coachEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("sentence"), text: z.string() }),
  z.object({ type: z.literal("done"), messageId: z.string(), body: z.string() }),
  z.object({ type: z.literal("refused"), reason: z.string(), message: z.string() }),
  z.object({ type: z.literal("busy") }),
  z.object({ type: z.literal("unreachable") }),
  z.object({ type: z.literal("limited"), retryAfterSeconds: z.number().int().min(0) }),
]);
export type CoachEvent = z.infer<typeof coachEventSchema>;
