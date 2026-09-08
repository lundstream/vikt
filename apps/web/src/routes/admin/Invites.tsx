import { useState } from "react";
import { formatLongDay } from "../../lib/dates.js";
import { LOCALE, t } from "../../i18n/index.js";
import { useAdminInvites, useMintInvite, useRevokeInvite } from "./api.js";

/**
 * Invite codes (D95, D100).
 *
 * Registration has been invite-only since phase 0, and until now the only way to
 * mint a code was `pnpm --filter api invite` on the machine with the database.
 * That is fine for the owner's own account and wrong for handing a code to
 * somebody standing in front of you.
 *
 * A minted code is shown once, here, and not stored anywhere the screen can go
 * back to. It is in the list underneath like every other unused code, so
 * "shown once" is about the highlight rather than about the value being lost.
 */
export function Invites() {
  const invites = useAdminInvites();
  const mint = useMintInvite();
  const revoke = useRevokeInvite();
  const [minted, setMinted] = useState<string | null>(null);

  if (invites.isLoading) {
    return (
      <p role="status" className="text-note text-muted">
        {t("app.loading")}
      </p>
    );
  }

  const rows = invites.data?.invites ?? [];

  return (
    <section data-testid="admin-invites">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          data-testid="mint-invite"
          className="btn w-auto px-6"
          disabled={mint.isPending}
          onClick={() => mint.mutate(undefined, { onSuccess: (r) => setMinted(r.code) })}
        >
          {t("admin.mintInvite")}
        </button>

        {minted ? (
          <p role="status" className="num text-note text-ink" data-testid="minted-code">
            {t("admin.newCode", { code: minted })}
          </p>
        ) : null}
      </div>

      {rows.some((invite) => invite.usedAt) ? (
        <p className="mb-4 max-w-prose text-note text-muted">{t("admin.revokeUsedHint")}</p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-note text-muted">{t("admin.noInvites")}</p>
      ) : (
        <ul className="divide-y divide-edge border-y border-edge">
          {rows.map((invite) => (
            <li
              key={invite.code}
              className="flex flex-wrap items-baseline justify-between gap-3 py-3"
              data-testid={`invite-${invite.code}`}
            >
              <span className="min-w-0">
                <span className="num block truncate text-body text-ink">{invite.code}</span>
                <span className="block truncate text-micro text-muted">
                  {invite.usedAt
                    ? t("admin.inviteUsed", {
                        date: formatLongDay(invite.usedAt.slice(0, 10), LOCALE),
                      })
                    : t("admin.inviteUnused")}
                  {invite.expiresAt
                    ? ` · ${t("admin.inviteExpires", {
                        date: formatLongDay(invite.expiresAt.slice(0, 10), LOCALE),
                      })}`
                    : ""}
                </span>
              </span>

              {/*
                Revoke only for an unused code (D95). A used one explains an
                account that exists, and revoking it would either do nothing or
                lie about what happened. The reason is stated once above the
                list rather than on each used row: twelve identical sentences
                down the right-hand side is noise, and it reads as though
                something were wrong with each of them.
              */}
              {invite.usedAt ? null : (
                <button
                  type="button"
                  data-testid={`revoke-${invite.code}`}
                  className="min-h-11 shrink-0 text-note text-muted underline underline-offset-4"
                  disabled={revoke.isPending}
                  onClick={() => {
                    setMinted(null);
                    revoke.mutate({ code: invite.code });
                  }}
                >
                  {t("admin.revoke")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
