import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { COACH_QUESTION_MAX, type CoachEvent } from "shared";
import { t } from "../i18n/index.js";
import { useLlmHealth } from "../lib/food.js";
import { useMe } from "../lib/session.js";
import { useLogDate } from "../lib/log-date.js";
import {
  askCoach,
  useConversation,
  useConversations,
  useRemoveAllConversations,
  useRemoveConversation,
  useReviews,
  useWriteReview,
} from "../lib/coach.js";
import { ConfirmSheet } from "../components/ConfirmSheet.js";
import { CoachTone } from "../components/CoachTone.js";

/**
 * The Coach page (D139), §6 phase 8b.
 *
 * **A place, not an icon.** The 8b amendment is explicit: no sparkle, no
 * floating button, no accent colour. A sparkle says "there is a language model
 * in here", which is a fact about the implementation rather than about what the
 * thing does for the reader, and a floating button lays a second navigation
 * over the one already at the bottom of the screen, which is the argument D53
 * made when it removed the raised centre button. The persona's name carries it.
 *
 * **The reviews and the chat, together.** They are the same voice from the same
 * prompt file, and splitting them across two screens would make them read as
 * two features.
 *
 * **Absent when the layer is off.** The route is not registered on the server,
 * the navigation entry is not drawn, and this screen is never reached. What it
 * handles instead is the *other* unavailability: the host being switched off,
 * which is ordinary and is said in a sentence with nothing else offered.
 */

type Line = { role: "user" | "coach"; body: string; refusal?: string | null };

export function Coach() {
  const health = useLlmHealth();
  const me = useMe();
  const { today } = useLogDate();
  const navigate = useNavigate();

  const conversations = useConversations();
  const reviews = useReviews();
  const writeReview = useWriteReview();
  const removeOne = useRemoveConversation();
  const removeAll = useRemoveAllConversations();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const stored = useConversation(conversationId);

  const [question, setQuestion] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const endOfLines = useRef<HTMLDivElement>(null);

  /** An open conversation replaces whatever was on screen. */
  useEffect(() => {
    if (stored.data === undefined) return;
    setLines(
      stored.data.messages.map((message) => ({
        role: message.role,
        body: message.body,
        refusal: message.refusal,
      })),
    );
  }, [stored.data]);

  useEffect(() => {
    // Guarded because `scrollIntoView` is not implemented everywhere a page can
    // be rendered, and a missing convenience must not take the screen down.
    endOfLines.current?.scrollIntoView?.({ block: "end" });
  }, [lines.length, streaming]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const asked = question.trim();
    if (asked === "" || streaming) return;

    setQuestion("");
    setNotice(null);
    setLines((current) => [...current, { role: "user", body: asked }, { role: "coach", body: "" }]);
    setStreaming(true);

    let answer = "";

    const apply = (incoming: CoachEvent) => {
      switch (incoming.type) {
        case "sentence":
          answer += (answer === "" ? "" : " ") + incoming.text;
          setLines((current) => {
            const next = [...current];
            next[next.length - 1] = { role: "coach", body: answer };
            return next;
          });
          return;
        case "done":
          void conversations.refetch();
          return;
        case "refused":
          setLines((current) => {
            const next = [...current];
            next[next.length - 1] = {
              role: "coach",
              body: incoming.message,
              refusal: incoming.reason,
            };
            return next;
          });
          return;
        case "busy":
          setNotice(t("coach.busy"));
          setLines((current) => current.slice(0, -1));
          return;
        case "unreachable":
          setNotice(t("coach.unreachable"));
          setLines((current) => current.slice(0, -1));
          return;
        case "limited":
          setNotice(t("coach.limited"));
          setLines((current) => current.slice(0, -1));
          return;
      }
    };

    try {
      await askCoach({ question: asked, conversationId, asOf: today }, apply);
    } catch {
      setNotice(t("coach.unreachable"));
      setLines((current) => current.slice(0, -1));
    } finally {
      setStreaming(false);
      if (conversationId === null) {
        // The turn created one; the list now knows which.
        const refreshed = await conversations.refetch();
        const newest = refreshed.data?.[0];
        if (newest) setConversationId(newest.id);
      }
    }
  };

  const newest = reviews.data?.[0] ?? null;

  /**
   * Who is speaking. The neutral tone has no name on purpose: a voice with
   * no character has nobody to be named after, and calling it Bengt anyway
   * would be the persona the person switched off.
   */
  const speaker =
    me.data?.profile.coachTone === "saklig" ? t("coach.nameNeutral") : t("coach.name");

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-6 sm:px-6">
      <h1 className="text-lg text-ink">{t("coach.title")}</h1>
      <p className="mt-1 max-w-prose text-note text-muted">{t("coach.what", { name: speaker })}</p>

      {/* The host being off is ordinary, and it is said once, with nothing else. */}
      {health.data && !health.data.reachable ? (
        <p className="mt-4 max-w-prose text-note text-ink" data-testid="coach-offline">
          {t("coach.unreachable")}
        </p>
      ) : null}

      {/*
        The two limits the checking cannot cover (D139, D140).

        In Sten, under the description, where somebody reads it before asking
        rather than after being told something wrong. The numbers are checked;
        the sentences around them are not, and the screens are where the figures
        somebody acts on actually live.
      */}
      <p className="mt-2 max-w-prose text-micro text-muted" data-testid="coach-limits">
        {t("coach.limits")}
      </p>

      {/* Which voice, for both the summary and the chat (D140). */}
      <CoachTone />

      {/* ------------------------------------------------------- the review */}

      <section className="mt-8" data-testid="coach-reviews">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base text-ink">{t("coach.reviewTitle")}</h2>
          <button
            type="button"
            className="btn-link text-micro"
            data-testid="coach-write-review"
            disabled={writeReview.isPending}
            onClick={() => {
              writeReview.mutate(today, {
                onSuccess: (result) => {
                  if (result.status === "unreachable") setNotice(t("coach.unreachable"));
                  if (result.status === "refused") setNotice(t("coach.reviewRefused"));
                },
                onError: () => setNotice(t("coach.unreachable")),
              });
            }}
          >
            {writeReview.isPending ? t("coach.writing") : t("coach.writeReview")}
          </button>
        </div>

        {newest ? (
          <article className="panel mt-3">
            <p className="num text-micro text-muted">
              {t("coach.weekOf", { date: newest.weekStart })}
            </p>
            <p className="mt-2 whitespace-pre-line text-body text-ink">{newest.body}</p>
          </article>
        ) : (
          <p className="mt-2 max-w-prose text-note text-muted">{t("coach.noReviews")}</p>
        )}
      </section>

      {/* --------------------------------------------------------- the chat */}

      <section className="mt-10" data-testid="coach-chat">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base text-ink">{t("coach.chatTitle", { name: speaker })}</h2>
          {lines.length > 0 ? (
            <button
              type="button"
              className="btn-link text-micro"
              data-testid="coach-new"
              onClick={() => {
                setConversationId(null);
                setLines([]);
                setNotice(null);
              }}
            >
              {t("coach.newConversation")}
            </button>
          ) : null}
        </div>

        {lines.length === 0 ? (
          <p className="mt-2 max-w-prose text-note text-muted">{t("coach.empty")}</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {lines.map((line, index) => (
              <li
                key={`${line.role}-${index}`}
                data-testid={line.role === "user" ? "coach-you" : "coach-said"}
              >
                <p className="text-micro text-muted">
                  {line.role === "user" ? t("coach.you") : speaker}
                </p>
                <p className="mt-1 whitespace-pre-line text-body text-ink">
                  {line.body === "" ? t("coach.thinking") : line.body}
                </p>
                {line.refusal ? (
                  <p className="mt-1 text-micro text-muted">{t("coach.refusedNote")}</p>
                ) : null}
              </li>
            ))}
            <div ref={endOfLines} />
          </ul>
        )}

        {notice !== null ? (
          <p role="status" className="mt-4 max-w-prose text-note text-ink" data-testid="coach-notice">
            {notice}
          </p>
        ) : null}

        <form onSubmit={send} className="mt-5">
          <label className="block text-micro text-muted" htmlFor="coach-question">
            {t("coach.ask")}
          </label>
          <textarea
            id="coach-question"
            className="field mt-1 w-full"
            data-testid="coach-question"
            rows={3}
            maxLength={COACH_QUESTION_MAX}
            value={question}
            placeholder={t("coach.placeholder")}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button
            type="submit"
            className="btn mt-3 w-auto px-6"
            data-testid="coach-send"
            disabled={streaming || question.trim() === ""}
          >
            {streaming ? t("coach.thinking") : t("coach.send")}
          </button>
        </form>

        {/*
          What the coach cannot do, where somebody would otherwise find out by
          asking. It reads, it never writes: a suggestion is a link to the
          screen where the person does the thing.
        */}
        {/*
          Two links in a sentence, and the punctuation has to sit against them.
          Written on one line on purpose: JSX turns a line break between an
          element and a comma into a space, which put a gap before every comma
          and full stop on the rendered page.
        */}
        <p className="mt-4 max-w-prose text-micro text-muted">
          {t("coach.readsOnly", { name: speaker })}{" "}
          <Link className="btn-link" to="/dag">{t("nav.daily")}</Link>
          {" och "}
          <Link className="btn-link" to="/food">{t("nav.food")}</Link>.
        </p>
      </section>

      {/* ------------------------------------------------------ the history */}

      <section className="mt-10" data-testid="coach-history">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base text-ink">{t("coach.historyTitle")}</h2>
          {(conversations.data ?? []).length > 0 ? (
            <button
              type="button"
              className="btn-link text-micro"
              data-testid="coach-forget-all"
              onClick={() => setConfirmingAll(true)}
            >
              {t("coach.forgetAll")}
            </button>
          ) : null}
        </div>

        <p className="mt-1 max-w-prose text-micro text-muted">{t("coach.historyWhat")}</p>

        {(conversations.data ?? []).length === 0 ? (
          <p className="mt-2 text-note text-muted">{t("coach.noHistory")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-edge border-y border-edge">
            {(conversations.data ?? []).map((conversation) => (
              <li key={conversation.id} className="flex items-baseline justify-between gap-3 py-2.5">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  data-testid={`coach-open-${conversation.id}`}
                  onClick={() => {
                    setConversationId(conversation.id);
                    setNotice(null);
                    navigate("/coach");
                  }}
                >
                  <span className="block truncate text-note text-ink">{conversation.title}</span>
                  <span className="num block text-micro text-muted">
                    {t("coach.turns", {
                      count: String(conversation.messages),
                      date: conversation.lastMessageAt.slice(0, 10),
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn-link shrink-0 text-micro"
                  data-testid={`coach-forget-${conversation.id}`}
                  disabled={removeOne.isPending}
                  onClick={() => {
                    removeOne.mutate(conversation.id, {
                      onSuccess: () => {
                        if (conversationId === conversation.id) {
                          setConversationId(null);
                          setLines([]);
                        }
                      },
                    });
                  }}
                >
                  {t("coach.forget")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmSheet
        open={confirmingAll}
        testId="coach-forget-all-confirm"
        title={t("coach.forgetAllTitle")}
        body={t("coach.forgetAllBody")}
        confirmLabel={t("coach.forgetAll")}
        busy={removeAll.isPending}
        onConfirm={() =>
          removeAll.mutate(undefined, {
            onSuccess: () => {
              setConfirmingAll(false);
              setConversationId(null);
              setLines([]);
            },
          })
        }
        onClose={() => setConfirmingAll(false)}
      />
    </div>
  );
}
