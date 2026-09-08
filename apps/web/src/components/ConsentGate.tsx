import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMe } from "../lib/session.js";
import { t } from "../i18n/index.js";

/**
 * Asks an existing account for consent, once (D107).
 *
 * Registration asks with a checkbox. Every account created before that column
 * existed has `consentedAt: null`, and this is how they are asked: on the next
 * sign-in, in front of the app rather than beside it.
 *
 * ## Why this one blocks, when nothing else in this app does
 *
 * §3 says the app has no failure state and nothing nags. This is not that. It
 * is the one thing that cannot honestly be deferred: weight and body
 * measurements handled for a health purpose are health data, and continuing to
 * store somebody's without asking is the position the checkbox exists to avoid.
 * Asking politely at the bottom of a settings page is asking in a way designed
 * not to be answered.
 *
 * It is also the only screen in the app with no way past it except forward,
 * which is why it offers the two other honest exits: read the text first, or
 * sign out. Nobody is trapped, and nobody is agreeing by scrolling.
 */
export function ConsentGate({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const queryClient = useQueryClient();

  const accept = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/me/consent", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ consentedAt: string }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] }),
  });

  // Not yet known, or already agreed: the app, unchanged.
  if (!me.data || me.data.consentedAt !== null) return <>{children}</>;

  return (
    <main className="mx-auto w-full max-w-xl px-5 py-12" data-testid="consent-gate">
      <h1 className="text-title text-ink">{t("consent.title")}</h1>

      <div className="mt-4 space-y-3 text-body text-muted">
        <p>
          <strong className="font-semibold text-ink">{t("consent.leadWhat")}</strong>{" "}
          {t("consent.what")}
        </p>
        <p>
          <strong className="font-semibold text-ink">{t("consent.leadWhy")}</strong>{" "}
          {t("consent.why")}
        </p>
        <p>
          <strong className="font-semibold text-ink">{t("consent.leadLeave")}</strong>{" "}
          {t("consent.leave")}
        </p>
      </div>

      <p className="mt-4">
        <a
          className="text-note text-muted underline underline-offset-4 hover:text-ink"
          href="/integritet"
        >
          {t("consent.readPrivacy")}
        </a>
        <span className="text-muted"> · </span>
        <a
          className="text-note text-muted underline underline-offset-4 hover:text-ink"
          href="/villkor"
        >
          {t("consent.readTerms")}
        </a>
      </p>

      <button
        type="button"
        data-testid="consent-accept"
        className="btn mt-8 w-auto px-6"
        disabled={accept.isPending}
        onClick={() => accept.mutate()}
      >
        {t("consent.accept")}
      </button>

      {accept.isError ? (
        <p role="status" className="mt-4 text-note text-muted">
          {t("consent.failed")}
        </p>
      ) : null}
    </main>
  );
}
