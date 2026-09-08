import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Link, Navigate } from "react-router-dom";
import { registerFormSchema, toRegisterRequest } from "shared";
import { ApiError, browserTimezone } from "../lib/api.js";
import { useMe, useRegister } from "../lib/session.js";
import { appName } from "../lib/app-name.js";
import { AuthShell } from "../components/AuthShell.js";
import {
  Field,
  fieldAria,
  fieldErrorsFrom,
  type FieldErrors,
} from "../components/Field.js";
import { t } from "../i18n/index.js";

export function Register() {
  const me = useMe();
  const register = useRegister();

  /**
   * The code from the invite mail's link (D109).
   *
   * Read once, as the initial value, rather than kept in sync with the URL: the
   * field is the user's from the moment the page renders, and a code they have
   * started editing must not be overwritten by a re-render.
   *
   * The field says it was filled in rather than silently arriving full. A form
   * that is mysteriously pre-populated is a form people distrust, and this one
   * has a good reason to give.
   */
  const [params] = useSearchParams();
  const codeFromLink = params.get("kod")?.trim() ?? "";
  const [inviteCode, setInviteCode] = useState(codeFromLink);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});

  if (me.data) return <Navigate to="/" replace />;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setErrors({});

    // The same schema the server uses, plus the confirmation rule, so the
    // messages agree with what the API would have said.
    const parsed = registerFormSchema.safeParse({
      inviteCode,
      email,
      password,
      confirmPassword,
      displayName,
      timezone: browserTimezone(),
      // Required by the schema as `literal(true)`, so a form that somehow
      // submits without it fails validation rather than registering somebody
      // who never agreed (D107).
      consent,
    });

    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }

    register.mutate(toRegisterRequest(parsed.data));
  }

  const submitError =
    register.error instanceof ApiError
      ? register.error.message
      : register.error
        ? t("auth.unreachable")
        : null;

  return (
    <AuthShell title={appName()} subtitle={t("auth.createAccount")}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field
          id="invite"
          label={t("auth.inviteCode")}
          error={errors.inviteCode}
          hint={codeFromLink === "" ? undefined : t("auth.codeFromLink")}
        >
          <input
            id="invite"
            className="field num tracking-widest"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            {...fieldAria("invite", errors.inviteCode)}
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder="ABCD-EFGH-JKLM-NPQR"
          />
        </Field>

        <Field id="displayName" label={t("auth.name")} error={errors.displayName}>
          <input
            id="displayName"
            className="field"
            autoComplete="nickname"
            required
            {...fieldAria("displayName", errors.displayName)}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>

        <Field id="email" label={t("auth.email")} error={errors.email}>
          <input
            id="email"
            className="field"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            {...fieldAria("email", errors.email)}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field
          id="password"
          label={t("auth.password")}
          error={errors.password}
          hint={t("auth.passwordHint")}
        >
          <input
            id="password"
            className="field"
            type="password"
            autoComplete="new-password"
            required
            {...fieldAria("password", errors.password, true)}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {/*
          There is no email in this app, so there is no password reset. A typo
          in a masked field would lock the account permanently.
        */}
        <Field id="confirmPassword" label={t("auth.passwordAgain")} error={errors.confirmPassword}>
          <input
            id="confirmPassword"
            className="field"
            type="password"
            autoComplete="new-password"
            required
            {...fieldAria("confirmPassword", errors.confirmPassword)}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
        </Field>

        {submitError ? (
          <p role="alert" className="text-note text-muted">
            {submitError}
          </p>
        ) : null}

        {/*
          Explicit, required, and stored with a timestamp (D107). Health data
          is the one thing that must not be agreed to by implication, so this is
          a box somebody ticks rather than a sentence under a button.
        */}
        <label className="flex items-start gap-3 text-note text-muted">
          <input
            type="checkbox"
            className="check mt-1"
            data-testid="consent"
            required
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            {t("auth.consentBefore")}{" "}
            <a
              className="underline underline-offset-4 hover:text-ink"
              href="/integritet"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("auth.consentPrivacy")}
            </a>{" "}
            {t("auth.consentAnd")}{" "}
            <a
              className="underline underline-offset-4 hover:text-ink"
              href="/villkor"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("auth.consentTerms")}
            </a>
            {t("auth.consentAfter")}
          </span>
        </label>

        <button className="btn" type="submit" disabled={register.isPending || !consent}>
          {register.isPending ? t("auth.creating") : t("auth.createAccount")}
        </button>
      </form>

      <p className="mt-6 text-note text-muted">
        {t("auth.alreadyHaveAccount")}{" "}
        <Link className="underline underline-offset-4 text-ink" to="/login">
          {t("auth.signIn")}
        </Link>
      </p>
    </AuthShell>
  );
}
