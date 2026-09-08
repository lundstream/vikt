import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AuthShell } from "../components/AuthShell.js";
import { Field, fieldAria } from "../components/Field.js";
import { t } from "../i18n/index.js";

/**
 * Password reset, both halves (D88).
 *
 * One route with two states rather than two routes, because they are one flow
 * and the second is only reachable from a link the first one sent.
 *
 * The request half **says the same thing whatever happened**. That is not
 * vagueness for its own sake: if the screen distinguished "sent" from "no such
 * account", anyone could use it to ask whether a given person has an account
 * here, and for a weight-tracking app that is a more sensitive disclosure than
 * it would be for most. The server answers identically too; this screen simply
 * does not have anything else to report.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token");

  return token ? <ChooseNew token={token} /> : <AskForLink />;
}

function AskForLink() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("sending");
    setProblem(null);

    const response = await fetch("/api/auth/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });

    if (response.ok) {
      setState("done");
      return;
    }

    // The only thing that can refuse is the rate limit, and it refuses on
    // volume rather than on anything about the address.
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    setProblem(body?.message ?? t("reset.problem"));
    setState("idle");
  }

  if (state === "done") {
    return (
      <AuthShell title={t("reset.title")} subtitle={t("reset.sentSubtitle")}>
        <p role="status" className="max-w-prose text-body text-muted">
          {t("reset.sent")}
        </p>
        <p className="mt-6">
          <Link className="text-note text-muted underline underline-offset-4" to="/login">
            {t("auth.signIn")}
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("reset.title")} subtitle={t("reset.subtitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="email" label={t("auth.email")}>
          <input
            id="email"
            className="field"
            type="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...fieldAria("email", undefined)}
          />
        </Field>

        {problem ? (
          <p role="status" className="text-micro text-muted">
            {problem}
          </p>
        ) : null}

        <button className="btn" type="submit" disabled={email.trim() === "" || state === "sending"}>
          {state === "sending" ? t("reset.sending") : t("reset.send")}
        </button>
      </form>

      <p className="mt-6">
        <Link className="text-note text-muted underline underline-offset-4" to="/login">
          {t("auth.signIn")}
        </Link>
      </p>
    </AuthShell>
  );
}

function ChooseNew({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState("saving");
    setProblem(null);

    const response = await fetch("/api/auth/reset/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });

    if (response.ok) {
      setState("done");
      return;
    }

    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    setProblem(body?.message ?? t("reset.problem"));
    setState("idle");
  }

  if (state === "done") {
    return (
      <AuthShell title={t("reset.doneTitle")} subtitle={t("reset.doneSubtitle")}>
        <p role="status" className="max-w-prose text-body text-muted">
          {t("reset.done")}
        </p>
        <p className="mt-6">
          <Link className="btn inline-flex w-auto px-4" to="/login">
            {t("auth.signIn")}
          </Link>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t("reset.newTitle")} subtitle={t("reset.newSubtitle")}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field id="password" label={t("auth.password")} hint={t("auth.passwordHint")}>
          <input
            id="password"
            className="field"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...fieldAria("password", undefined)}
          />
        </Field>

        {problem ? (
          <p role="status" className="text-micro text-muted">
            {problem}
          </p>
        ) : null}

        <button className="btn" type="submit" disabled={password.length < 10 || state === "saving"}>
          {state === "saving" ? t("quick.saving") : t("reset.save")}
        </button>
      </form>
    </AuthShell>
  );
}
