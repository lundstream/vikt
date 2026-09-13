import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { coachEventSchema, type CoachEvent, type CoachReview } from "shared";
import { api } from "./api.js";

/**
 * The coach (D139), §6 phase 8b.
 *
 * The one surface in this app that streams. `fetch` rather than `EventSource`,
 * because the turn is a POST with a body and `EventSource` can only GET, and
 * because the response is read to completion here anyway: the events arrive on
 * the same connection the question went out on, which is one fewer thing to
 * reconnect.
 */

export const COACH_KEY = ["coach"] as const;
export const REVIEW_KEY = ["coach", "review"] as const;

export function useConversations(enabled = true) {
  return useQuery({
    queryKey: [...COACH_KEY, "conversations"],
    enabled,
    queryFn: () => api.coachConversations(),
    select: (data) => data.conversations,
    retry: false,
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: [...COACH_KEY, "conversation", id],
    enabled: id !== null,
    queryFn: () => api.coachConversation(id!),
    retry: false,
  });
}

/** The newest weekly review that has not been put away, or null. */
export function useCurrentReview(enabled = true) {
  return useQuery({
    queryKey: REVIEW_KEY,
    enabled,
    queryFn: () => api.coachCurrentReview(),
    select: (data) => data.review,
    retry: false,
  });
}

export function useReviews(enabled = true) {
  return useQuery({
    queryKey: [...COACH_KEY, "reviews"],
    enabled,
    queryFn: () => api.coachReviews(),
    select: (data) => data.reviews,
    retry: false,
  });
}

export function useDismissReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.dismissReview(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: REVIEW_KEY }),
  });
}

export function useWriteReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (asOf: string) => api.writeReview(asOf),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: COACH_KEY });
    },
  });
}

export function useRemoveConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.removeConversation(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: COACH_KEY }),
  });
}

export function useRemoveAllConversations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.removeAllConversations(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: COACH_KEY }),
  });
}

/**
 * One turn, read off the stream as it arrives.
 *
 * Each `data:` line is one event, and every event has already passed the
 * server's guardrail check before it was written — a sentence on this stream is
 * a sentence that may be shown. That is why this function does not need to
 * hold anything back: the holding back happens where the numbers are known.
 */
export async function askCoach(
  body: { question: string; conversationId: string | null; asOf: string },
  onEvent: (event: CoachEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/coach/ask", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || response.body === null) {
    onEvent({ type: "unreachable" });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  const consume = (block: string) => {
    const line = block.replace(/^data:\s*/, "").trim();
    if (line === "") return;

    try {
      const parsed = coachEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) onEvent(parsed.data);
    } catch {
      // A truncated line cannot happen here: only complete blocks are passed.
      // A malformed one is dropped rather than taking the turn down with it.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffered += decoder.decode(value, { stream: true });
    const blocks = buffered.split("\n\n");
    buffered = blocks.pop() ?? "";
    for (const block of blocks) consume(block);
  }

  consume(buffered);
}

export type { CoachReview };
