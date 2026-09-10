import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sheet } from "./Sheet.js";
import { t } from "../i18n/index.js";

/**
 * Leaving, from Inställningar (D107).
 *
 * The same three properties the admin deletion has (D95), because it is the
 * same cascade and there is no reason for a person to get a worse version of
 * it than an operator does:
 *
 *  - **It states its consequences first.** "Radera kontot" is an abstraction;
 *    "84 vägningar, 113 matrader" is what is about to happen, and the counts
 *    come from the same tables the cascade will empty.
 *  - **It offers the export before the delete**, in the same panel, because the
 *    moment somebody decides to leave is the only moment they will think to
 *    take their data, and a link they have to go and find is a link they will
 *    not find.
 *  - **It asks for the password.** A session cookie is enough to read and
 *    write; it is not enough to destroy. A borrowed phone should not be able to
 *    erase a year of logging in one tap.
 */

type Preview = {
  email: string;
  weights: number;
  foodEntries: number;
  dailyLogs: number;
  photos: number;
};

export function DeleteAccount() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [password, setPassword] = useState("");
  const [typedEmail, setTypedEmail] = useState("");

  /** Trimmed and case-insensitive: typing it is the point, not spelling it in caps. */
  const emailMatches =
    preview !== null &&
    typedEmail.trim().toLowerCase() === preview.email.trim().toLowerCase();
  const [problem, setProblem] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/me/delete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.status === 403) throw new Error("wrong_password");
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      /**
       * A full load rather than a client-side navigation. The account is gone,
       * every cached query in memory refers to rows that no longer exist, and
       * the cheapest way to be certain none of it is shown again is to throw
       * the whole page away.
       */
      window.location.assign("/");
    },
    onError: (error: Error) =>
      setProblem(
        error.message === "wrong_password"
          ? t("account.wrongPassword")
          : t("account.deleteFailed"),
      ),
  });

  async function start() {
    setProblem(null);
    setPassword("");
    const response = await fetch("/api/me/deletion", { credentials: "same-origin" });
    if (!response.ok) {
      setProblem(t("account.deleteFailed"));
      return;
    }
    setPreview((await response.json()) as Preview);
  }

  return (
    <section className="mt-10 border-t border-edge pt-6" data-testid="delete-account">
      <h2 className="text-base text-ink">{t("account.deleteHeading")}</h2>
      <p className="mt-2 max-w-prose text-note text-muted">{t("account.deleteWhat")}</p>

      {/* The export, first and in the same place. */}
      <p className="mt-3 max-w-prose text-note text-muted">
        <a
          className="text-ink underline underline-offset-4"
          href="/api/export/json"
          data-testid="export-before-delete"
        >
          {t("account.exportFirst")}
        </a>{" "}
        {t("account.exportHint")}
      </p>

      <button
        type="button"
        data-testid="start-delete"
        className="btn-secondary mt-4 w-auto px-6"
        onClick={() => void start()}
      >
        {t("account.deleteStart")}
      </button>

      {problem && preview === null ? (
        <p role="status" className="mt-3 text-note text-muted">
          {problem}
        </p>
      ) : null}

      <Sheet
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={t("account.deleteHeading")}
        testId="delete-account-sheet"
      >
        {preview ? (
          <>
            <p className="text-body text-ink">{t("account.deleteRows")}</p>
            <ul className="num mt-3 space-y-1 text-note text-muted">
              <li>{t("account.deleteWeights", { n: preview.weights })}</li>
              <li>{t("account.deleteFood", { n: preview.foodEntries })}</li>
              <li>{t("account.deleteDays", { n: preview.dailyLogs })}</li>
              <li>{t("account.deletePhotos", { n: preview.photos })}</li>
            </ul>

            <label className="mt-6 block text-micro text-muted">
              {t("account.passwordToConfirm")}
              <input
                id="delete-password"
                className="field mt-1 w-full"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p className="mt-2 max-w-prose text-micro text-muted">
              {t("account.passwordWhy")}
            </p>

            {/*
              And the address typed out (D123).

              The password and this guard different things, which is why both
              stay. The password **authorises**: without it somebody holding an
              unlocked phone could delete the account, and the address is on
              screen under Profil for them to read. Typing the address makes it
              **deliberate**: it is the step that cannot be completed by
              tapping through a sheet without reading it.

              Compared case-insensitively and trimmed. Somebody who capitalises
              their own address differently has still typed it, and refusing
              them on that would be a puzzle rather than a safeguard.
            */}
            <label className="mt-5 block text-micro text-muted">
              {t("account.typeEmailToConfirm")}
              <input
                id="delete-email"
                className="field mt-1 w-full"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder={preview.email}
                value={typedEmail}
                onChange={(event) => setTypedEmail(event.target.value)}
              />
            </label>

            {problem ? (
              <p role="status" className="mt-3 text-note text-ink">
                {problem}
              </p>
            ) : null}

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                data-testid="confirm-delete-account"
                className="btn-impact w-auto px-6"
                disabled={password === "" || !emailMatches || remove.isPending}
                onClick={() => remove.mutate()}
              >
                {t("account.deleteConfirm")}
              </button>
              <button
                type="button"
                className="btn-secondary w-auto px-6"
                onClick={() => setPreview(null)}
              >
                {t("common.cancel")}
              </button>
            </div>
          </>
        ) : null}
      </Sheet>
    </section>
  );
}
