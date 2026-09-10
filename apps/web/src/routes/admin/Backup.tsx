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
  smbHost: string;
  smbShare: string;
  smbDomain: string;
  smbUsername: string;
  /** Whether one is stored, never the password itself (D130). */
  smbPasswordSet: boolean;
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

  const [kind, setKind] = useState<"local" | "smb">("local");
  const [path, setPath] = useState("");
  const [clock, setClock] = useState("");
  const [retain, setRetain] = useState("30");
  const [host, setHost] = useState("");
  const [share, setShare] = useState("");
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  /**
   * Empty means "leave the stored one alone" (D130).
   *
   * The screen never receives the password, so there is nothing to prefill and
   * nothing to send back unless somebody types a new one. Clearing it is its
   * own control below, because "clear" and "leave alone" are two intentions and
   * an empty box cannot be both.
   */
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded.data) return;
    const settings = loaded.data.settings;
    setKind(settings.destinationKind === "smb" ? "smb" : "local");
    setPath(settings.destinationPath);
    setClock(toClock(settings.scheduleMinute));
    setRetain(String(settings.retainDays));
    setHost(settings.smbHost);
    setShare(settings.smbShare);
    setDomain(settings.smbDomain);
    setUsername(settings.smbUsername);
  }, [loaded.data]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/backup", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destinationKind: kind,
          destinationPath: path,
          scheduleMinute: fromClock(clock),
          retainDays: Number(retain) || 30,
          ...(kind === "smb"
            ? {
                smbHost: host,
                smbShare: share,
                smbDomain: domain,
                smbUsername: username,
                // Absent leaves it alone; an explicit empty string clears it.
                ...(clearPassword ? { smbPassword: "" } : password === "" ? {} : { smbPassword: password }),
              }
            : {}),
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
      setPassword("");
      setClearPassword(false);
      void queryClient.invalidateQueries({ queryKey: ["admin", "backup"] });
    },
    onError: (error: Error) => {
      setNotice(null);
      setProblem(error.message);
    },
  });

  /**
   * Writes a probe file to the destination and deletes it again (D130).
   *
   * It tests what is **saved**, not what is typed, which is why it sits below
   * the save button rather than beside the fields: a test of unsaved values
   * would pass and then the schedule would run against the old ones.
   */
  const test = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/backup/test", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{
        ok: boolean;
        wrote: string | null;
        reason: string | null;
      }>;
    },
    onSuccess: (result) => {
      setNotice(result.ok ? t("backup.testOk") : null);
      setProblem(result.ok ? null : `${t("backup.testFailed")} ${result.reason ?? ""}`.trim());
      void queryClient.invalidateQueries({ queryKey: ["admin", "log"] });
    },
    onError: () => setProblem(t("backup.testFailed")),
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
        {/*
          Where it goes, chosen before anything is typed, because the fields
          below mean different things for each and a form that showed both at
          once would be asking for a path and a share at the same time.
        */}
        <label className="block text-micro text-muted">
          {t("backup.kind")}
          <select
            id="backup-kind"
            data-testid="backup-kind"
            className="select mt-1 w-full"
            value={kind}
            onChange={(event) => setKind(event.target.value as "local" | "smb")}
          >
            <option value="local">{t("backup.kindLocal")}</option>
            <option value="smb">{t("backup.kindSmb")}</option>
          </select>
        </label>

        {kind === "smb" ? (
          <div className="space-y-4" data-testid="backup-smb-fields">
            <div className="flex gap-4">
              <label className="block flex-1 text-micro text-muted">
                {t("backup.smbHost")}
                <input
                  id="backup-smb-host"
                  className="field mt-1 w-full"
                  placeholder="nas.local"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                />
              </label>
              <label className="block flex-1 text-micro text-muted">
                {t("backup.smbShare")}
                <input
                  id="backup-smb-share"
                  className="field mt-1 w-full"
                  placeholder="backup"
                  value={share}
                  onChange={(event) => setShare(event.target.value)}
                />
              </label>
            </div>

            <label className="block text-micro text-muted">
              {t("backup.smbFolder")}
              <input
                id="backup-path"
                className="field mt-1 w-full"
                placeholder="vikt"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </label>

            <div className="flex gap-4">
              <label className="block flex-1 text-micro text-muted">
                {t("backup.smbUser")}
                <input
                  id="backup-smb-user"
                  className="field mt-1 w-full"
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label className="block flex-1 text-micro text-muted">
                {t("backup.smbDomain")}
                <input
                  id="backup-smb-domain"
                  className="field mt-1 w-full"
                  autoComplete="off"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                />
              </label>
            </div>

            <label className="block text-micro text-muted">
              {t("backup.smbPassword")}
              <input
                id="backup-smb-password"
                data-testid="backup-smb-password"
                className="field mt-1 w-full"
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={clearPassword}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {/*
              The stored password is never sent to this screen, so there is
              nothing to prefill: an empty box means "leave it alone". Clearing
              it is a separate control, because "clear" and "leave alone" are
              two intentions and one empty field cannot express both.
            */}
            {data?.settings.smbPasswordSet ? (
              <>
                <p className="text-micro text-muted">{t("backup.smbPasswordSet")}</p>
                <label className="flex items-center gap-2 text-micro text-muted">
                  <input
                    type="checkbox"
                    className="check"
                    data-testid="backup-smb-clear"
                    checked={clearPassword}
                    onChange={(event) => setClearPassword(event.target.checked)}
                  />
                  {t("backup.smbPasswordClear")}
                </label>
              </>
            ) : null}

            <div className="space-y-1 text-micro text-muted">
              <p>{t("backup.smbHelp")}</p>
              <p>{t("backup.smbVersion")}</p>
            </div>
          </div>
        ) : (
          <>
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
              Examples and a failure mode, because "Katalog att skriva till" on
              its own does not say whether the directory has to exist or what
              happens when it cannot be written. A share the host already
              mounts is still the answer for a server this client cannot talk
              to, and it is a local path like any other.
            */}
            <div className="space-y-1 text-micro text-muted">
              <p>{t("backup.pathHelp")}</p>
              <p>{t("backup.pathExamples")}</p>
              <p>{t("backup.pathUnwritable")}</p>
            </div>
          </>
        )}

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

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            data-testid="save-backup"
            className="btn w-auto px-6"
            disabled={save.isPending}
          >
            {t("profile.save")}
          </button>

          {/*
            Tests what is saved, not what is typed. A test of unsaved values
            would pass and then the schedule would run against the old ones.
          */}
          <button
            type="button"
            data-testid="test-backup"
            className="btn-secondary w-auto px-6"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t("backup.testing") : t("backup.test")}
          </button>
        </div>
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
