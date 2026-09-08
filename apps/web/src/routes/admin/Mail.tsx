import { LOCALE, t, type TranslationKey } from "../../i18n/index.js";
import { useAdminMail, useRetryMail } from "./api.js";

/**
 * The outbound queue (D88, D95, D100).
 *
 * The list has been on this screen since D89. What was missing is the retry,
 * which is the only reason a person looks at a mail queue at all: seeing that a
 * reset never went out is worth something only if the next thing you can do is
 * send it.
 *
 * §3's honesty rule applies to the app's own failures, so a failed row keeps its
 * error text rather than a status word. "Gick inte att skicka" says nothing a
 * person can act on. "535 5.7.8 Username and Password not accepted" does.
 */
export function Mail() {
  const mail = useAdminMail();
  const retry = useRetryMail();

  if (mail.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const rows = mail.data?.mail ?? [];
  const worker = mail.data?.worker ?? null;

  /**
   * A tick older than five minutes is a stalled drainer.
   *
   * The interval is thirty seconds, so five minutes is ten missed ticks: long
   * enough that a slow send or a restart does not read as a fault, short enough
   * that a real stall is visible while somebody is still looking at the screen.
   */
  const stalled =
    worker === null || Date.now() - new Date(worker.lastTickAt).getTime() > 5 * 60_000;

  const pending = rows.filter((row) => row.status === "pending").length;

  return (
    <section data-testid="admin-mail">
      {/*
        The drainer, above the queue rather than below it. The defect this
        answers is that "Väntar" and "nothing is running" looked identical, and
        the queue is the thing you are looking at when you need to tell them
        apart (D104).
      */}
      <dl className="panel mb-6 grid max-w-md grid-cols-2 gap-x-6 gap-y-3 text-note">
        <dt className="text-muted">{t("admin.workerLastTick")}</dt>
        <dd className="num text-right text-ink" data-testid="worker-tick">
          {worker ? new Date(worker.lastTickAt).toLocaleString(LOCALE) : t("stat.notYet")}
        </dd>

        <dt className="text-muted">{t("admin.workerSent")}</dt>
        <dd className="num text-right text-ink" data-testid="worker-sent">
          {worker ? String(worker.sentSinceStart) : t("stat.notYet")}
        </dd>
      </dl>

      {stalled && pending > 0 ? (
        <p className="mb-6 max-w-prose text-note text-ink" data-testid="worker-stalled">
          {t("admin.workerStalled", { n: pending })}
        </p>
      ) : null}

      {worker?.lastError ? (
        <p className="mb-6 max-w-prose text-note text-muted" data-testid="worker-error">
          {worker.lastError}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-note text-muted">{t("admin.noMail")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {rows.map((row) => (
            <li key={row.id} className="py-3" data-testid={`mail-${row.id}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-note text-ink">{row.subject}</span>
                  <span className="block truncate text-micro text-muted">{row.toAddress}</span>
                </span>

                <span className="flex shrink-0 items-baseline gap-4">
                  <span className="num text-micro text-muted">
                    {t(`admin.mail.${row.status}` as TranslationKey)}
                    {row.attempts > 0 ? ` · ${t("queue.attempts", { n: row.attempts })}` : ""}
                  </span>

                  {/*
                    Only what has actually stopped. A pending row is already
                    going to be tried again, and a retry button on it would
                    invite a second send of something that had not failed.
                  */}
                  {row.status === "failed" ? (
                    <button
                      type="button"
                      data-testid={`retry-${row.id}`}
                      className="min-h-11 text-note text-ink underline underline-offset-4"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate({ id: row.id })}
                    >
                      {t("admin.retry")}
                    </button>
                  ) : null}
                </span>
              </div>

              {/* A failure is never silent: the reason is on the row. */}
              {row.lastError ? (
                <p className="mt-1 max-w-prose text-micro text-muted">{row.lastError}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
