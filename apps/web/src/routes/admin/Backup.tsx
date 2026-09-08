import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatLongDay } from "../../lib/dates.js";
import { LOCALE, t } from "../../i18n/index.js";

/**
 * Backups (D103).
 *
 * D96 wrote `infra/backup.sh`, documented it, and rehearsed a restore. What it
 * never did was install the cron line, so for two passes the only backups that
 * existed were the ones taken by hand. This screen is the schedule made visible:
 * when the next one is due, when the last one ran, how big it was, and what went
 * wrong if something did.
 *
 * **Restore is not here.** It is a documented command, because the one operation
 * that destroys a live database by succeeding should require somebody to type
 * it, and a button four pixels from "run now" is not that.
 */

type Settings = {
  destinationKind: "local" | "smb" | "s3";
  destinationPath: string;
  scheduleMinute: number | null;
  retainDays: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

type Run = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "ok" | "failed";
  startedByEmail: string | null;
  destination: string;
  fileName: string | null;
  bytes: number | null;
  error: string | null;
};

type Loaded = {
  settings: Settings;
  runs: Run[];
  nextRunAt: string | null;
  secretKeyPresent: boolean;
  downloadable: boolean;
};

/** `480` becomes `08:00`. The stored form is minutes, the shown form is a clock. */
function toClock(minute: number | null): string {
  if (minute === null) return "";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function fromClock(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute <= 1439 ? minute : null;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1
    ? `${mb.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} MB`
    : `${Math.round(bytes / 1024).toLocaleString(LOCALE)} kB`;
}

export function Backup() {
  const queryClient = useQueryClient();

  const loaded = useQuery({
    queryKey: ["admin", "backup"],
    queryFn: async (): Promise<Loaded> => {
      const response = await fetch("/api/admin/backup", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<Loaded>;
    },
    retry: false,
  });

  const [path, setPath] = useState("");
  const [clock, setClock] = useState("");
  const [retain, setRetain] = useState("30");
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded.data) return;
    setPath(loaded.data.settings.destinationPath);
    setClock(toClock(loaded.data.settings.scheduleMinute));
    setRetain(String(loaded.data.settings.retainDays));
  }, [loaded.data]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/backup", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationKind: "local",
          destinationPath: path,
          scheduleMinute: fromClock(clock),
          retainDays: Number(retain) || 30,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? String(response.status));
      }
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      setProblem(null);
      setNotice(t("backup.saved"));
      void queryClient.invalidateQueries({ queryKey: ["admin", "backup"] });
    },
    onError: (error: Error) => {
      setNotice(null);
      setProblem(error.message);
    },
  });

  const run = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/backup/run", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{
        ok: boolean;
        fileName: string | null;
        bytes: number | null;
        reason: string | null;
      }>;
    },
    onSuccess: (result) => {
      setNotice(result.ok ? t("backup.ranOk", { size: formatBytes(result.bytes) }) : null);
      setProblem(result.ok ? null : result.reason);
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: () => setProblem(t("backup.runFailed")),
  });

  if (loaded.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const data = loaded.data;
  const last = data?.runs.find((entry) => entry.status !== "running") ?? null;

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <section data-testid="admin-backup">
      <p className="mb-4 max-w-prose text-note text-muted">{t("backup.what")}</p>

      {data && !data.secretKeyPresent ? (
        <p className="mb-4 max-w-prose text-note text-ink" data-testid="backup-no-key">
          {t("backup.noKey")}
        </p>
      ) : null}

      {/*
        Status first, because it is the question the screen exists to answer:
        did the last one work, and when is the next one.
      */}
      <dl className="panel mb-6 grid max-w-md grid-cols-2 gap-x-6 gap-y-3 text-note">
        <dt className="text-muted">{t("backup.lastRun")}</dt>
        <dd className="num text-right text-ink" data-testid="backup-last">
          {last
            ? `${formatLongDay(last.startedAt.slice(0, 10), LOCALE)}${
                last.status === "ok" ? ` · ${formatBytes(last.bytes)}` : ` · ${t("backup.failed")}`
              }`
            : t("stat.notYet")}
        </dd>

        <dt className="text-muted">{t("backup.nextRun")}</dt>
        <dd className="num text-right text-ink" data-testid="backup-next">
          {data?.nextRunAt
            ? `${formatLongDay(data.nextRunAt.slice(0, 10), LOCALE)} ${data.nextRunAt.slice(11, 16)}`
            : t("backup.noSchedule")}
        </dd>

        <dt className="text-muted">{t("backup.destination")}</dt>
        <dd className="truncate text-right text-ink">
          {data?.settings.destinationPath || t("stat.notYet")}
        </dd>
      </dl>

      {/* The reason, whenever the last run has one. §3: never a silent failure. */}
      {last?.error ? (
        <p className="mb-6 max-w-prose text-note text-muted" data-testid="backup-error">
          {last.error}
        </p>
      ) : null}

      <div className="mb-8 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="run-backup"
          className="btn w-auto px-6"
          disabled={run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending ? t("backup.running") : t("backup.runNow")}
        </button>

        {/*
          A link rather than a fetch: the browser saves the file, and the app
          does not hold a copy of every user's data in memory to hand it over.
        */}
        <a
          className={`btn-secondary inline-flex w-auto px-6 ${
            data?.downloadable ? "" : "pointer-events-none opacity-50"
          }`}
          href="/api/admin/backup/latest"
          data-testid="download-backup"
          aria-disabled={data?.downloadable ? undefined : true}
        >
          {t("backup.download")}
        </a>
      </div>

      {notice ? (
        <p role="status" className="mb-4 max-w-prose text-note text-ink" data-testid="backup-notice">
          {notice}
        </p>
      ) : null}
      {problem ? (
        <p role="status" className="mb-4 max-w-prose text-note text-ink" data-testid="backup-problem">
          {problem}
        </p>
      ) : null}

      <form onSubmit={submit} className="panel max-w-md space-y-4">
        <label className="block text-micro text-muted">
          {t("backup.path")}
          <input
            id="backup-path"
            className="field mt-1 w-full"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>

        {/*
          Three examples and a failure mode, because "Katalog att skriva till"
          on its own does not say whether a UNC path works, whether the
          directory has to exist, or what happens when it cannot be written.
          The SMB answer is the useful one: mount it, and it becomes local.
        */}
        <div className="space-y-1 text-micro text-muted">
          <p>{t("backup.pathHelp")}</p>
          <p>{t("backup.pathExamples")}</p>
          <p>{t("backup.pathUnwritable")}</p>
        </div>

        <div className="flex gap-4">
          <label className="block flex-1 text-micro text-muted">
            {t("backup.time")}
            <input
              id="backup-time"
              className="field mt-1 w-full"
              placeholder="03:17"
              value={clock}
              onChange={(event) => setClock(event.target.value)}
            />
          </label>

          <label className="block flex-1 text-micro text-muted">
            {t("backup.retain")}
            <input
              id="backup-retain"
              className="field mt-1 w-full"
              inputMode="numeric"
              value={retain}
              onChange={(event) => setRetain(event.target.value.replace(/\D/g, ""))}
            />
          </label>
        </div>

        <p className="text-micro text-muted">{t("backup.timeHint")}</p>

        <button
          type="submit"
          data-testid="save-backup"
          className="btn w-auto px-6"
          disabled={save.isPending}
        >
          {t("profile.save")}
        </button>
      </form>

      <p className="mt-6 max-w-prose text-micro text-muted">{t("backup.restoreHint")}</p>

      {(data?.runs.length ?? 0) > 0 ? (
        <ul className="mt-6 divide-y divide-edge border-y border-edge">
          {data!.runs.map((entry) => (
            <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2">
              <span className="num min-w-0 truncate text-micro text-muted">
                {formatLongDay(entry.startedAt.slice(0, 10), LOCALE)} {entry.startedAt.slice(11, 16)}
                {entry.startedByEmail ? ` · ${entry.startedByEmail}` : ` · ${t("backup.bySchedule")}`}
              </span>
              <span className="num shrink-0 text-micro text-muted">
                {entry.status === "ok"
                  ? formatBytes(entry.bytes)
                  : entry.status === "running"
                    ? t("backup.running")
                    : t("backup.failed")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
