import { useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import { ApiError } from "../lib/api.js";
import { useLogin, useMe } from "../lib/session.js";
import { appName } from "../lib/app-name.js";
import { AuthShell } from "../components/AuthShell.js";
import { t } from "../i18n/index.js";

export function Login() {
  const me = useMe();
  const login = useLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (me.data) return <Navigate to="/" replace />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password });
  }

  return (
    <AuthShell title={appName()} subtitle={t("auth.signIn")}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="email">
            {t("auth.email")}
          </label>
          <input
            id="email"
            className="field"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            {t("auth.password")}
          </label>
          <input
            id="password"
            className="field"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {login.error ? (
          <p role="alert" className="text-note text-muted">
            {login.error instanceof ApiError
              ? login.error.message
              : t("auth.unreachable")}
          </p>
        ) : null}

        <button className="btn" type="submit" disabled={login.isPending}>
          {login.isPending ? t("auth.signingIn") : t("auth.signIn")}
        </button>
      </form>

      {/* The way back in, where someone who cannot get in is looking (D88). */}
      <p className="mt-6 text-note text-muted">
        <Link className="underline underline-offset-4" to="/nytt-losenord">
          {t("reset.forgot")}
        </Link>
      </p>

      <p className="mt-2 text-note text-muted">
        {t("auth.haveInvite")}{" "}
        <Link className="underline underline-offset-4 text-ink" to="/register">
          {t("auth.createAccount")}
        </Link>
      </p>
    </AuthShell>
  );
}
