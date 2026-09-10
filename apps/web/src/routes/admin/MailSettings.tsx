import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "../../i18n/index.js";

/**
 * The mail server, configured from the app (D102).
 *
 * D94 said deployment modes live in the environment and are never a toggle in
 * the admin UI, and that still holds for the two that decide whether a feature
 * exists. Mail is not that shape. It is a connection to somebody else's server,
 * with a host that changes, a password that rotates, and a failure the operator
 * has to diagnose without a shell on the box.
 *
 * **The password is write-only.** It is never sent to this screen, so the field
 * starts empty and stays empty, and leaving it empty on save means "keep the one
 * you have". Clearing a stored password is its own explicit action rather than
 * an empty field, because an empty field is what you get by not typing.
 */

type Settings = {
  host: string;
  port: number;
  security: "starttls" | "tls" | "none";
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
  secretsReadable: boolean;
};

type Loaded = {
  settings: Settings | null;
  secretKeyPresent: boolean;
  /** The base every link in every mail is built from, and whether it is local (D113). */
  baseUrl: string | null;
  baseUrlIsLocal: boolean;
};

const EMPTY: Settings = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  hasPassword: false,
  fromAddress: "",
  fromName: "",
  updatedAt: null,
  updatedByEmail: null,
  secretsReadable: true,
};

export function MailSettings() {
  const queryClient = useQueryClient();

  const loaded = useQuery({
    queryKey: ["admin", "mail-settings"],
    queryFn: async (): Promise<Loaded> => {
      const response = await fetch("/api/admin/mail-settings", { credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<Loaded>;
    },
    retry: false,
  });

  const [form, setForm] = useState<Settings>(EMPTY);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** Seed the form once the server has answered, and not on every render. */
  useEffect(() => {
    if (loaded.data?.settings) setForm(loaded.data.settings);
  }, [loaded.data]);

  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/mail-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: form.host,
          port: form.port,
          security: form.security,
          username: form.username,
          // Absent means keep, "" means clear. Neither is the same as the other.
          ...(clearPassword ? { password: "" } : password === "" ? {} : { password }),
          fromAddress: form.fromAddress,
          fromName: form.fromName,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? String(response.status));
      }
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      setPassword("");
      setClearPassword(false);
      setProblem(null);
      setNotice(t("mail.saved"));
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error: Error) => {
      setNotice(null);
      setProblem(error.message);
    },
  });

  const test = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/admin/mail-settings/test", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ ok: boolean; to: string; reason: string | null }>;
    },
    onSuccess: (result) => {
      setProblem(result.ok ? null : (result.reason ?? t("mail.testFailed")));
      setNotice(result.ok ? t("mail.testSent", { email: result.to }) : null);
    },
    onError: () => setProblem(t("mail.testFailed")),
  });

  if (loaded.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const settings = loaded.data?.settings ?? null;
  const keyPresent = loaded.data?.secretKeyPresent ?? false;
  const baseUrl = loaded.data?.baseUrl ?? null;
  const baseUrlIsLocal = loaded.data?.baseUrlIsLocal ?? false;

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <section data-testid="admin-mail-settings">
      <p className="mb-4 max-w-prose text-note text-muted">{t("mail.what")}</p>

      {/*
        The two states worth saying out loud before anything else, because both
        mean "a password cannot be used" and neither is a wrong password.
      */}
      {!keyPresent ? (
        <p className="mb-4 max-w-prose text-note text-ink" data-testid="no-secret-key">
          {t("mail.noKey")}
        </p>
      ) : null}
      {settings && !settings.secretsReadable ? (
        <p className="mb-4 max-w-prose text-note text-ink" data-testid="key-changed">
          {t("mail.keyChanged")}
        </p>
      ) : null}

      {/*
        The address every link in every mail is built from (D113).
        
        Printed here because this is where somebody stands when they send mail,
        and because the failure it exists for was invisible from every other
        vantage point: `https://localhost:5173` sat in a live instance's
        environment, every invite went out linking to a dev server, the queue
        said sent, and the only way to find out was to read a delivered
        message.
        
        No accent on the warning (§5, profile page 8): this screen has none, and
        a colour that only appears on a bad day builds a failure state. It is a
        sentence in Snö, which is what the rest of the app does with a fact
        somebody needs to act on.
      */}
      <div className="mb-4 max-w-prose" data-testid="mail-base-url">
        <p className="text-note text-muted">
          {t("mail.baseUrl")}{" "}
          <span className="text-ink">{baseUrl ?? t("mail.baseUrlMissing")}</span>
        </p>
        {baseUrlIsLocal ? (
          <p className="mt-1 text-note text-ink" data-testid="base-url-local">
            {t("mail.baseUrlLocal")}
          </p>
        ) : null}
      </div>

      <form onSubmit={submit} className="panel max-w-md space-y-4" noValidate>
        <label className="block text-micro text-muted">
          {t("mail.host")}
          <input
            id="mail-host"
            className="field mt-1 w-full"
            value={form.host}
            onChange={(event) => setForm({ ...form, host: event.target.value })}
          />
        </label>

        <div className="flex gap-4">
          <label className="block flex-1 text-micro text-muted">
            {t("mail.port")}
            <input
              id="mail-port"
              className="field mt-1 w-full"
              inputMode="numeric"
              value={String(form.port)}
              onChange={(event) =>
                setForm({ ...form, port: Number(event.target.value.replace(/\D/g, "")) || 0 })
              }
            />
          </label>

          <label className="block flex-1 text-micro text-muted">
            {t("mail.security")}
            <select
              id="mail-security"
              className="select mt-1 w-full"
              value={form.security}
              onChange={(event) =>
                setForm({ ...form, security: event.target.value as Settings["security"] })
              }
            >
              <option value="starttls">{t("mail.starttls")}</option>
              <option value="tls">{t("mail.tls")}</option>
              <option value="none">{t("mail.none")}</option>
            </select>
          </label>
        </div>

        <label className="block text-micro text-muted">
          {t("mail.username")}
          <input
            id="mail-username"
            className="field mt-1 w-full"
            autoComplete="off"
            value={form.username}
            onChange={(event) => setForm({ ...form, username: event.target.value })}
          />
        </label>

        {/*
          Write-only. The stored password is never sent here, so this field says
          whether one exists rather than showing it, and an empty field keeps it.
        */}
        <label className="block text-micro text-muted">
          {settings?.hasPassword ? t("mail.passwordStored") : t("mail.password")}
          <input
            id="mail-password"
            className="field mt-1 w-full"
            type="password"
            autoComplete="new-password"
            placeholder={settings?.hasPassword ? t("mail.passwordKeep") : ""}
            value={password}
            disabled={clearPassword}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {settings?.hasPassword ? (
          <label className="flex items-center gap-2 text-micro text-muted">
            <input
              type="checkbox"
              className="check"
              data-testid="clear-password"
              checked={clearPassword}
              onChange={(event) => {
                setClearPassword(event.target.checked);
                if (event.target.checked) setPassword("");
              }}
            />
            {t("mail.passwordClear")}
          </label>
        ) : null}

        <label className="block text-micro text-muted">
          {t("mail.fromAddress")}
          <input
            id="mail-from"
            className="field mt-1 w-full"
            type="email"
            value={form.fromAddress}
            onChange={(event) => setForm({ ...form, fromAddress: event.target.value })}
          />
        </label>

        <label className="block text-micro text-muted">
          {t("mail.fromName")}
          <input
            id="mail-from-name"
            className="field mt-1 w-full"
            value={form.fromName}
            onChange={(event) => setForm({ ...form, fromName: event.target.value })}
          />
        </label>

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            data-testid="save-mail-settings"
            className="btn-impact w-auto px-6"
            disabled={save.isPending}
          >
            {t("profile.save")}
          </button>

          {/*
            Only to the signed-in admin, and the label says so, because a button
            called "send test" beside an address field reads as though it will
            use the address in the field.
          */}
          <button
            type="button"
            data-testid="send-test-mail"
            className="btn w-auto px-6"
            disabled={test.isPending || !settings}
            onClick={() => test.mutate()}
          >
            {t("mail.sendTest")}
          </button>
        </div>
      </form>

      {notice ? (
        <p role="status" className="mt-4 max-w-prose text-note text-ink" data-testid="mail-notice">
          {notice}
        </p>
      ) : null}
      {problem ? (
        <p role="status" className="mt-4 max-w-prose text-note text-ink" data-testid="mail-problem">
          {problem}
        </p>
      ) : null}

      {/* Who last changed it, because this decides who receives every reset. */}
      {settings?.updatedAt ? (
        <p className="mt-6 text-micro text-muted">
          {settings.updatedByEmail
            ? t("mail.changedBy", { email: settings.updatedByEmail })
            : t("mail.changedByImport")}
        </p>
      ) : null}
    </section>
  );
}
