import { Link } from "react-router-dom";
import { formatDecimal } from "shared";
import {
  useQueuedMutations,
  useQueueState,
  useUnresolvedConflicts,
} from "../lib/queue/useQueue.js";
import { db } from "../lib/queue/db.js";
import { discardMutation, drainQueue, retryMutation } from "../lib/queue/sync.js";
import { queueDegraded } from "../lib/queue/enqueue.js";
import { formatLongDay } from "../lib/dates.js";
import { LOCALE, plural, t, type TranslationKey } from "../i18n/index.js";
import { DeleteAccount } from "../components/DeleteAccount.js";
import { NewsMailToggle } from "../components/NewsMailToggle.js";
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
                <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-micro text-muted">
                  <dt>{t("settings.conflictTheirs")}</dt>
                  <dd className="text-right text-ink">{describe(row.theirs)}</dd>
                  <dt>{t("settings.conflictMine")}</dt>
                  <dd className="text-right text-ink">{describe(row.mine)}</dd>
                </dl>
                <button
                  type="button"
                  data-testid={`resolve-${row.id}`}
                  className="mt-2 px-2 py-2 text-micro text-ink underline underline-offset-4"
                  onClick={() =>
                    void db.conflicts.update(row.id!, {
                      resolvedAt: new Date().toISOString(),
                    })
                  }
                >
                  {t("settings.conflictKeepTheirs")}
                </button>
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

                {row.status !== "pending" ? (
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

      {/* The look of the app, per account rather than per device (D117). */}
      <ThemeChoice />

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
