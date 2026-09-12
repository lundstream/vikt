import { Link } from "react-router-dom";
import { formatDecimal } from "shared";
import {
  useQueuedMutations,
  useQueueState,
  useUnresolvedConflicts,
} from "../lib/queue/useQueue.js";
import {
  discardMutation,
  drainQueue,
  keepServerForMutation,
  keepServerReading,
  retryMutation,
  applyQueuedForMutation,
  applyQueuedReading,
} from "../lib/queue/sync.js";
import { queueDegraded } from "../lib/queue/enqueue.js";
import { formatLongDay } from "../lib/dates.js";
import { LOCALE, plural, t, type TranslationKey } from "../i18n/index.js";
import { DeleteAccount } from "../components/DeleteAccount.js";
import { NewsMailToggle, RequestMailToggle } from "../components/NewsMailToggle.js";
import { Reminders } from "../components/Reminders.js";
import { InstallApp } from "../components/InstallApp.js";
import { ThemeChoice } from "../components/ThemeChoice.js";

/**
 * Settings, and the queue inspector.
 *
 * The inspector is a debugging tool that a user will occasionally need, so it
 * is plain rather than pretty: what is waiting, what was refused and why, and
 * the two actions that resolve either. Nothing here is automatic, because every
 * row in it represents something a person typed.
 */
export function Settings() {
  const { pending, attention } = useQueueState();
  const mutations = useQueuedMutations();
  const conflicts = useUnresolvedConflicts();

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <header className="mb-8 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-title text-ink">{t("settings.title")}</h1>
          {/*
            Three states, not two. Saying "0 poster väntar" while a conflict is
            sitting below it is technically true and useless: nothing is
            waiting to be *sent*, but something is waiting for a person.
          */}
          <p className="text-note text-muted">
            {attention > 0
              ? plural(attention, "sync.needsYouOne", "sync.needsYou")
              : pending > 0
                ? plural(pending, "sync.pendingOne", "sync.pending")
                : t("settings.queueClean")}
          </p>
        </div>
        <Link className="text-note text-muted underline underline-offset-4" to="/">
          {t("nav.dashboard")}
        </Link>
      </header>

      {/* ------------------------------------------------------ conflicts */}
      {conflicts.length > 0 ? (
        <section className="mb-8">
          <h2 className="text-base text-ink">{t("settings.conflicts")}</h2>
          <p className="mt-1 max-w-prose text-note text-muted">{t("settings.conflictsNote")}</p>

          <ul className="mt-3 divide-y divide-edge border-y border-edge">
            {conflicts.map((row) => (
              <li key={row.id} className="py-3">
                <p className="text-note text-ink">{formatLongDay(row.localDate, LOCALE)}</p>
                {/*
                  Which collision this is (D150). Two creates for one day is the
                  case this section was written for; an edit whose row moved
                  underneath it is the other, and saying "two devices" about a
                  person editing their own reading is how this page came to be
                  looked at in the first place.
                */}
                <p className="mt-1 max-w-prose text-micro text-muted">
                  {row.reason === "changed_since"
                    ? t("settings.conflictChanged")
                    : t("settings.conflictSameDay")}
                </p>
                <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-micro text-muted">
                  <dt>{t("settings.conflictTheirs")}</dt>
                  <dd className="text-right text-ink">{describe(row.theirs)}</dd>
                  <dt>{t("settings.conflictMine")}</dt>
                  <dd className="text-right text-ink">{describe(row.mine)}</dd>
                </dl>
                {/*
                  Two answers, and they are equals (D150).

                  This offered one, "Behåll den som redan finns", which is the
                  shape of a dialog where the other answer is really "go away".
                  A conflict is a question with two answers and the person is
                  the only one who knows which is right, so both are filled
                  buttons of the same tier and neither is styled as the way out.
                */}
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    data-testid={`keep-server-${row.id}`}
                    className="btn w-auto px-4"
                    onClick={() => void keepServerReading(row.id!)}
                  >
                    {t("settings.conflictKeepTheirs")}
                  </button>
                  <button
                    type="button"
                    data-testid={`use-mine-${row.id}`}
                    className="btn w-auto px-4"
                    onClick={() => void applyQueuedReading(row.id!)}
                  >
                    {t("settings.conflictUseMine")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------------------------------------------- the inspector */}
      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-base text-ink">{t("settings.queue")}</h2>
          {pending > 0 ? (
            <button
              type="button"
              data-testid="drain-now"
              className="px-2 py-2 text-micro text-ink underline underline-offset-4"
              onClick={() => void drainQueue()}
            >
              {t("settings.sendNow")}
            </button>
          ) : null}
        </div>

        {/*
          The queue opened and would not take a row (D118). Said here because
          it changes what the app can do: logging still works, and it stops
          working the moment the network does. §3 has no failure state, but
          this is not a failure, it is a capability that is missing, and D42's
          rule is that the app says so rather than letting somebody find out in
          a basement.
        */}
        {queueDegraded() ? (
          <p className="mt-2 max-w-prose text-note text-ink" data-testid="queue-degraded">
            {t("settings.queueUnwritable")}
          </p>
        ) : null}

        {mutations.length === 0 ? (
          <p className="mt-2 max-w-prose text-note text-muted">{t("settings.queueEmpty")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-edge border-y border-edge">
            {mutations.map((row) => (
              <li key={row.id} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-note text-ink">
                    {t(`queue.kind.${row.kind}` as TranslationKey)}
                  </span>
                  <span className="num text-micro text-muted">
                    {formatLongDay(row.localDate, LOCALE)}
                    {/*
                      Whether that day is the device's own or one a person
                      picked (D61). Without it, a queued row for three weeks ago
                      is indistinguishable from a device with a wrong clock, and
                      those want opposite responses.
                    */}
                    {row.dateSource === "chosen" ? ` · ${t("queue.chosenDate")}` : ""}
                  </span>
                </div>

                <p className="num mt-1 text-micro text-muted">
                  {t(`queue.status.${row.status}` as TranslationKey)}
                  {row.attempts > 0
                    ? ` · ${plural(row.attempts, "queue.attemptOne", "queue.attempts", {
                        n: formatDecimal(row.attempts, { decimals: 0 }),
                      })}`
                    : ""}
                </p>

                {/*
                  The server's own message, verbatim. It is already in Swedish
                  and already says the useful thing; paraphrasing it here would
                  put two versions of one explanation in the codebase.
                */}
                {row.failure ? (
                  <p className="mt-1 max-w-prose text-micro text-muted">{row.failure.message}</p>
                ) : null}

                {/*
                  A conflicted row gets the conflict's own two answers, not
                  "Försök igen" (D150).

                  Retrying a conflict sends the identical bytes to the identical
                  rule and gets the identical answer: the control could never
                  work, and offering it made the page look like the fault was
                  the network's. A conflict is a question, and this is where the
                  person is already standing.
                */}
                {row.status === "conflict" ? (
                  <div className="mt-2 flex flex-wrap gap-3">
                    <button
                      type="button"
                      data-testid={`queue-keep-server-${row.id}`}
                      className="btn w-auto px-4"
                      onClick={() => void keepServerForMutation(row.id!)}
                    >
                      {t("settings.conflictKeepTheirs")}
                    </button>
                    <button
                      type="button"
                      data-testid={`queue-use-mine-${row.id}`}
                      className="btn w-auto px-4"
                      onClick={() => void applyQueuedForMutation(row.id!)}
                    >
                      {t("settings.conflictUseMine")}
                    </button>
                  </div>
                ) : row.status !== "pending" ? (
                  <div className="mt-2 flex gap-4">
                    <button
                      type="button"
                      data-testid={`retry-${row.id}`}
                      className="px-2 py-2 text-micro text-ink underline underline-offset-4"
                      onClick={() => void retryMutation(row.id!)}
                    >
                      {t("settings.retry")}
                    </button>
                    <button
                      type="button"
                      data-testid={`discard-${row.id}`}
                      className="px-2 py-2 text-micro text-muted underline underline-offset-4"
                      onClick={() => void discardMutation(row.id!)}
                    >
                      {t("settings.discard")}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        The news-mail opt-out (D108). Only news: maintenance mail is not
        opt-out, because it concerns the service somebody is using rather than
        something they might find interesting, and /integritet says both.
      */}
      <NewsMailToggle />
      <RequestMailToggle />



      {/* The look of the app, per account rather than per device (D117). */}
      <ThemeChoice />

      {/*
        The two reminders (D136), directly above the install control.

        §6 wants the line about iOS beside the switch, and the control that
        answers it one section away rather than inside this one: Inställningar
        already has an install control, and two copies of it on one screen is
        worse than either placement.
      */}
      <Reminders />

      {/*
        Installing (D116). Above the offline explainer on purpose: the two are
        the same subject read in order, since what works offline is mostly a
        property of the installed app.
      */}
      <InstallApp />

      <section className="mt-10 border-t border-edge pt-6">
        <h2 className="text-base text-ink">{t("settings.whatWorksOffline")}</h2>
        <p className="mt-2 max-w-prose text-note text-muted">{t("settings.offlineExplainer")}</p>
      </section>

      {/*
        The profile link used to live here, as a footnote at the bottom of
        settings. It is its own destination in the Mer sheet now, so a second
        way in from halfway down another screen is one place too many to look.
      */}

      <DeleteAccount />
    </main>
  );
}

/**
 * One line describing a queued body, for the conflict comparison.
 *
 * Deliberately dumb: it reads the two fields that actually differ in practice
 * rather than rendering a generic key/value dump, which is unreadable at the
 * exact moment someone needs to make a choice.
 */
function describe(body: Record<string, unknown>): string {
  if (typeof body.weightKg === "number") {
    return `${formatDecimal(body.weightKg, { decimals: 1 })} kg`;
  }
  if (typeof body.kcal === "number") {
    return `${formatDecimal(body.kcal, { decimals: 0 })} kcal`;
  }
  return t("settings.conflictOther");
}
